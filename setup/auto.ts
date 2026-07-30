/**
 * Non-interactive setup driver — the step sequencer for `pnpm run setup:auto`.
 *
 * Responsibility: orchestrate the sequence of steps end-to-end and route
 * between them. The runner, spawning, status parsing, spinner, abort, and
 * prompt primitives live in `setup/lib/runner.ts`; theming in
 * `setup/lib/theme.ts`; Telegram's full flow in `setup/channels/telegram.ts`.
 *
 * Config via env:
 *   NANOCLAW_DISPLAY_NAME  how the agents address the operator — skips the
 *                          prompt. Defaults to $USER.
 *   NANOCLAW_AGENT_NAME    messaging-channel agent name (consumed by the
 *                          channel flow). The CLI scratch agent is always
 *                          "Terminal Agent".
 *   NANOCLAW_SKIP          comma-separated step names to skip
 *                          (environment|container|onecli|auth|mounts|
 *                           service|cli-agent|channel|verify|first-chat)
 *
 * Timezone defaults to the host system's TZ. Run
 *   pnpm exec tsx setup/index.ts --step timezone -- --tz <zone>
 * later if autodetect is wrong.
 */
import { spawn, spawnSync } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import { runDiscordChannel } from './channels/discord.js';
import { runTelegramChannel } from './channels/telegram.js';
import { pingCliAgent, type PingResult } from './lib/agent-ping.js';
import * as setupLog from './logs.js';
import { ensureAnswer, fail, runQuietChild, runQuietStep } from './lib/runner.js';
import { brandBold, brandChip, dimWrap, wrapForGutter } from './lib/theme.js';

const CLI_AGENT_NAME = 'Terminal Agent';
const RUN_START = Date.now();

async function main(): Promise<void> {
  printIntro();
  initProgressionLog();

  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const res = await runQuietStep('environment', {
      running: 'Checking your system…',
      done: 'Your system looks good.',
    });
    if (!res.ok) {
      fail(
        'environment',
        "Your system doesn't look quite right.",
        'See logs/setup-steps/ for details, then retry.',
      );
    }
  }

  if (!skip.has('container')) {
    p.log.message(
      dimWrap(
        'Your assistant lives in its own sandbox. It can only see what you explicitly share.',
        4,
      ),
    );
    const res = await runQuietStep('container', {
      running: 'Preparing the sandbox your assistant runs in…',
      done: 'Sandbox ready.',
      failed: "Couldn't prepare the sandbox.",
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        fail(
          'container',
          "Docker isn't available.",
          'Install Docker Desktop (or start it if already installed), then retry.',
        );
      }
      if (err === 'docker_group_not_active') {
        fail(
          'container',
          "Docker was just installed but your shell doesn't know yet.",
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
        );
      }
      fail(
        'container',
        "Couldn't build the sandbox.",
        'If Docker has a stale cache, try: `docker builder prune -f`, then retry.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('onecli')) {
    p.log.message(
      dimWrap(
        'Your assistant never gets your API keys directly. The vault adds them to approved requests as they leave the sandbox.',
        4,
      ),
    );
    const res = await runQuietStep('onecli', {
      running: "Setting up OneCLI, your agent's vault…",
      done: 'OneCLI vault ready.',
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'onecli_not_on_path_after_install') {
        fail(
          'onecli',
          'OneCLI was installed but your shell needs to refresh to see it.',
          'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
        );
      }
      fail(
        'onecli',
        `Couldn't set up OneCLI (${err ?? 'unknown error'}).`,
        'Make sure curl is installed and ~/.local/bin is writable, then retry.',
      );
    }
  }

  if (!skip.has('auth')) {
    await runAuthStep();
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep(
      'mounts',
      {
        running: "Setting your assistant's access rules…",
        done: 'Access rules set.',
        skipped: 'Access rules already set.',
      },
      ['--empty'],
    );
    if (!res.ok) {
      fail('mounts', "Couldn't write access rules.");
    }
  }

  if (!skip.has('service')) {
    const res = await runQuietStep('service', {
      running: 'Starting NanoClaw in the background…',
      done: 'NanoClaw is running.',
    });
    if (!res.ok) {
      fail(
        'service',
        "Couldn't start NanoClaw.",
        'See logs/nanoclaw.error.log for details.',
      );
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      p.log.warn(
        "NanoClaw's permissions need a tweak before it can reach Docker.",
      );
      p.log.message(
        k.dim(
          '  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' +
            '  systemctl --user restart nanoclaw',
        ),
      );
    }
  }

  let displayName: string | undefined;
  const needsDisplayName = !skip.has('cli-agent') || !skip.has('channel');
  if (needsDisplayName) {
    const fallback = process.env.USER?.trim() || 'Operator';
    const preset = process.env.NANOCLAW_DISPLAY_NAME?.trim();
    displayName = preset || (await askDisplayName(fallback));
  }

  if (!skip.has('cli-agent')) {
    const res = await runQuietStep(
      'cli-agent',
      {
        running: 'Bringing your assistant online…',
        done: 'Assistant wired up.',
      },
      ['--display-name', displayName!, '--agent-name', CLI_AGENT_NAME],
    );
    if (!res.ok) {
      fail(
        'cli-agent',
        "Couldn't bring your assistant online.",
        `You can retry later with \`pnpm exec tsx scripts/init-cli-agent.ts --display-name "${displayName!}" --agent-name "${CLI_AGENT_NAME}"\`.`,
      );
    }
    if (!skip.has('first-chat')) {
      const ping = await confirmAssistantResponds();
      if (ping === 'ok') {
        await runFirstChat();
      } else {
        renderPingFailureNote(ping);
      }
    }
  }

  if (!skip.has('channel')) {
    const choice = await askChannelChoice();
    if (choice === 'telegram') {
      await runTelegramChannel(displayName!);
    } else if (choice === 'discord') {
      await runDiscordChannel(displayName!);
    } else {
      p.log.info(
        wrapForGutter(
          'No messaging app for now. You can add one later (like Telegram, Discord, or Slack).',
          4,
        ),
      );
    }
  }

  if (!skip.has('verify')) {
    const res = await runQuietStep('verify', {
      running: 'Making sure everything works together…',
      done: "Everything's connected.",
      failed: 'A few things still need your attention.',
    });
    if (!res.ok) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push('• Your Claude account isn\'t connected. Re-run setup and try again.');
      }
      const service = res.terminal?.fields.SERVICE;
      if (service === 'running_other_checkout') {
        notes.push(
          wrapForGutter(
            [
              '• Your NanoClaw service is running from a different folder on this machine.',
              '  Point it at this checkout with:',
              '    launchctl bootout gui/$(id -u)/com.nanoclaw',
              '    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist',
            ].join('\n'),
            6,
          ),
        );
      } else {
        const agentPing = res.terminal?.fields.AGENT_PING;
        if (agentPing && agentPing !== 'ok' && agentPing !== 'skipped') {
          notes.push(
            "• Your assistant didn't reply to a test message. " +
              'Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.',
          );
        }
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push('• Want to chat from your phone? Add a messaging app with `/add-telegram`, `/add-slack`, or `/add-discord`.');
      }
      if (notes.length > 0) {
        p.note(notes.join('\n'), "What's left");
      }
      p.outro(k.yellow('Almost there. A few things still need your attention.'));
      return;
    }
  }

  const rows: [string, string][] = [
    ['Chat in the terminal:', 'pnpm run chat hi'],
    ["See what's happening:", 'tail -f logs/nanoclaw.log'],
    ['Open Claude Code:', 'claude'],
  ];
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const nextSteps = rows
    .map(([l, c]) => `${k.cyan(l.padEnd(labelWidth))}  ${c}`)
    .join('\n');
  p.note(nextSteps, 'Try these');
  setupLog.complete(Date.now() - RUN_START);
  p.outro(k.green("You're ready! Enjoy NanoClaw."));
}

// ─── first-chat step ───────────────────────────────────────────────────

/**
 * Round-trip ping against the CLI socket before we ask the user to chat.
 * Renders its own spinner with elapsed time because a cold-start container
 * boot can take 30–60s — the elapsed counter is the difference between
 * "patient" and "is this hung?". Returns the raw result so the caller can
 * branch between the chat loop (ok) and a diagnostic note (anything else).
 */
async function confirmAssistantResponds(): Promise<PingResult> {
  const s = p.spinner();
  const start = Date.now();
  const label = 'Waking your assistant…';
  s.start(label);
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    s.message(`${label} ${k.dim(`(${elapsed}s)`)}`);
  }, 1000);

  const result = await pingCliAgent();

  clearInterval(tick);
  const elapsed = Math.round((Date.now() - start) / 1000);
  if (result === 'ok') {
    s.stop(`Your assistant is ready. ${k.dim(`(${elapsed}s)`)}`);
  } else {
    const msg =
      result === 'socket_error'
        ? "Couldn't reach the NanoClaw service."
        : "Your assistant didn't reply in time.";
    s.stop(`${msg} ${k.dim(`(${elapsed}s)`)}`, 1);
  }
  return result;
}

function renderPingFailureNote(result: PingResult): void {
  const body =
    result === 'socket_error'
      ? [
          wrapForGutter(
            "The NanoClaw service isn't listening on its local socket. Try restarting it, then chat with `pnpm run chat hi`:",
            6,
          ),
          '',
          k.dim('  macOS:  launchctl kickstart -k gui/$(id -u)/com.nanoclaw'),
          k.dim('  Linux:  systemctl --user restart nanoclaw'),
        ].join('\n')
      : wrapForGutter(
          'No reply from your assistant within 30 seconds. Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.',
          6,
        );
  p.note(body, 'Skipping the first chat');
}

/**
 * Chat loop. Each message is piped through `pnpm run chat`, which uses
 * the same Unix-socket path the ping just exercised, so output streams
 * back inline as the agent replies. An empty input ends the loop.
 */
async function runFirstChat(): Promise<void> {
  while (true) {
    const answer = ensureAnswer(
      await p.text({
        message: 'Say something to your assistant',
        placeholder: 'press Enter with nothing to continue',
      }),
    );
    const text = ((answer as string | undefined) ?? '').trim();
    if (!text) return;
    await sendChatMessage(text);
  }
}

function sendChatMessage(message: string): Promise<void> {
  return new Promise((resolve) => {
    // `pnpm --silent` suppresses the `> nanoclaw@… chat` preamble so the
    // agent's reply reads as a clean block under the prompt. Splitting on
    // whitespace mirrors `pnpm run chat hello world` — chat.ts joins argv
    // with spaces on the far side.
    const child = spawn(
      'pnpm',
      ['--silent', 'run', 'chat', ...message.split(/\s+/)],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

// ─── auth step (select → branch) ────────────────────────────────────────

async function runAuthStep(): Promise<void> {
  if (anthropicSecretExists()) {
    p.log.success('Your Claude account is already connected.');
    setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    return;
  }

  const method = ensureAnswer(
    await p.select({
      message: 'How would you like to connect to Claude?',
      options: [
        {
          value: 'subscription',
          label: 'Sign in with my Claude subscription',
          hint: 'recommended if you have Pro or Max',
        },
        {
          value: 'oauth',
          label: 'Paste an OAuth token I already have',
          hint: 'sk-ant-oat…',
        },
        {
          value: 'api',
          label: 'Paste an Anthropic API key',
          hint: 'pay-per-use via console.anthropic.com',
        },
      ],
    }),
  ) as 'subscription' | 'oauth' | 'api';
  setupLog.userInput('auth_method', method);

  if (method === 'subscription') {
    await runSubscriptionAuth();
  } else {
    await runPasteAuth(method);
  }
}

async function runSubscriptionAuth(): Promise<void> {
  p.log.step("Opening the Claude sign-in flow…");
  console.log(
    k.dim('   (a browser will open for sign-in; this part is interactive)'),
  );
  console.log();
  const start = Date.now();
  const code = await runInheritScript('bash', [
    'setup/register-claude-token.sh',
  ]);
  const durationMs = Date.now() - start;
  console.log();
  if (code !== 0) {
    setupLog.step('auth', 'failed', durationMs, {
      EXIT_CODE: code,
      METHOD: 'subscription',
    });
    fail(
      'auth',
      "Couldn't complete the Claude sign-in.",
      'Re-run setup and try again, or choose a paste option instead.',
    );
  }
  setupLog.step('auth', 'interactive', durationMs, { METHOD: 'subscription' });
  p.log.success('Claude account connected.');
}

async function runPasteAuth(method: 'oauth' | 'api'): Promise<void> {
  const label = method === 'oauth' ? 'OAuth token' : 'API key';
  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';

  const answer = ensureAnswer(
    await p.password({
      message: `Paste your ${label}`,
      validate: (v) => {
        if (!v || !v.trim()) return 'Required';
        if (!v.trim().startsWith(prefix)) {
          return `Should start with ${prefix}…`;
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();

  const res = await runQuietChild(
    'auth',
    'onecli',
    [
      'secrets', 'create',
      '--name', 'Anthropic',
      '--type', 'anthropic',
      '--value', token,
      '--host-pattern', 'api.anthropic.com',
    ],
    {
      running: `Saving your ${label} to your OneCLI vault…`,
      done: 'Claude account connected.',
    },
    {
      extraFields: { METHOD: method },
    },
  );
  if (!res.ok) {
    fail(
      'auth',
      `Couldn't save your ${label} to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
    );
  }
}

// ─── prompts owned by the sequencer ────────────────────────────────────

async function askDisplayName(fallback: string): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant call you?',
      placeholder: fallback,
      defaultValue: fallback,
    }),
  );
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('display_name', value);
  return value;
}

async function askChannelChoice(): Promise<'telegram' | 'discord' | 'skip'> {
  const choice = ensureAnswer(
    await p.select({
      message: 'Want to chat with your assistant from your phone?',
      options: [
        { value: 'telegram', label: 'Yes, connect Telegram', hint: 'recommended' },
        { value: 'discord', label: 'Yes, connect Discord' },
        { value: 'skip', label: 'Skip for now', hint: "I'll just use the terminal" },
      ],
    }),
  );
  setupLog.userInput('channel_choice', String(choice));
  return choice as 'telegram' | 'discord' | 'skip';
}

// ─── interactive / env helpers ─────────────────────────────────────────

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  p.log.warn('Docker socket not accessible in current group. Re-executing under `sg docker`.');
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, NANOCLAW_REEXEC_SG: '1' },
  });
  process.exit(res.status ?? 1);
}

// ─── intro + progression-log init ──────────────────────────────────────

function printIntro(): void {
  const isReexec = process.env.NANOCLAW_REEXEC_SG === '1';
  const wordmark = `${k.bold('Nano')}${brandBold('Claw')}`;

  if (isReexec) {
    p.intro(
      `${brandChip(' Welcome ')}  ${wordmark}  ${k.dim('· picking up where we left off')}`,
    );
    return;
  }

  // Always include the wordmark inside the clack intro line. When bash ran
  // first (NANOCLAW_BOOTSTRAPPED=1) it already printed its own wordmark
  // above us; the small repeat is worth it to keep the brand anchored at
  // the visible top of the clack session once the bash output scrolls away.
  p.intro(`${wordmark}  ${k.dim("Let's get you set up.")}`);
}

/**
 * Bootstrap (nanoclaw.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.NANOCLAW_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: process.cwd(),
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
