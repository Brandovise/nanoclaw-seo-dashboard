/**
 * Legacy /api/* routes — same paths as reference dashboard for UI compatibility.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { listContainerLogFiles, listGroupFolders, stripAnsi, tailFile } from '../lib/fs-utils.js';
import { collectV2Messages } from '../lib/messages.js';
import { getV2ReadonlyDb, hasTable } from '../lib/nanoclaw-db.js';
import { listActiveDockerAgents } from '../lib/docker-agents.js';
import { listSkillsForGroup } from '../lib/skills.js';
import { parseLocalUsage } from '../lib/tokens.js';

let logTailOffset = 0;

function jsonOk(c: { json: (a: unknown, s?: number) => Response }, data: unknown, status = 200) {
  return c.json(data, status);
}

export function createNanoclawRouter(cfg: AppConfig, _seo: Database.Database): Hono {
  const r = new Hono();

  r.get('/api/stats', (c) => {
    const db = getV2ReadonlyDb(cfg);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();
    let messagesToday = 0;
    let repliesToday = 0;
    if (hasTable(db, 'messages')) {
      messagesToday = (
        db.prepare(`SELECT COUNT(*) as c FROM messages WHERE timestamp >= ? AND is_bot_message = 0`).get(todayIso) as { c: number }
      ).c;
      repliesToday = (
        db.prepare(`SELECT COUNT(*) as c FROM messages WHERE timestamp >= ? AND is_bot_message = 1`).get(todayIso) as { c: number }
      ).c;
    }
    if (messagesToday === 0 && repliesToday === 0) {
      const v2m = collectV2Messages(cfg, db)
        .filter((m) => m.chat_jid !== '__group_sync__')
        .filter((m) => m.timestamp >= todayIso);
      messagesToday = v2m.filter((m) => m.is_bot_message === 0).length;
      repliesToday = v2m.filter((m) => m.is_bot_message === 1).length;
    }
    const activeTasks = hasTable(db, 'scheduled_tasks')
      ? ((db.prepare(`SELECT COUNT(*) as c FROM scheduled_tasks WHERE status = 'active'`).get() as { c: number }).c ?? 0)
      : 0;
    const taskRunsToday = hasTable(db, 'task_run_logs')
      ? ((db.prepare(`SELECT COUNT(*) as c FROM task_run_logs WHERE run_at >= ?`).get(todayIso) as { c: number }).c ?? 0)
      : 0;
    const taskErrorsToday = hasTable(db, 'task_run_logs')
      ? ((
          db
            .prepare(`SELECT COUNT(*) as c FROM task_run_logs WHERE run_at >= ? AND status = 'error'`)
            .get(todayIso) as { c: number }
        ).c ?? 0)
      : 0;
    const groupCount = (db.prepare(`SELECT COUNT(*) as c FROM agent_groups`).get() as { c: number }).c;
    const runningSessions = db
      .prepare("SELECT COUNT(*) as c FROM sessions WHERE container_status IN ('running','idle')")
      .get() as { c: number };
    return jsonOk(c, {
      messagesToday,
      repliesToday,
      activeTasks,
      taskRunsToday,
      taskErrorsToday,
      groupCount,
      activeAgents: runningSessions.c,
      maxAgents: cfg.MAX_CONCURRENT_CONTAINERS,
      queueWaiting: 0,
    });
  });

  r.get('/api/messages', (c) => {
    const db = getV2ReadonlyDb(cfg);
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') ?? '50', 10)));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10));
    const chatJid = c.req.query('group') ?? null;
    const search = c.req.query('search') ?? null;
    const type = c.req.query('type') ?? 'all';
    const searchNorm = search?.toLowerCase() || null;
    const filtered = collectV2Messages(cfg, db)
      .filter((m) => m.chat_jid !== '__group_sync__')
      .filter((m) => (chatJid ? m.chat_jid === chatJid : true))
      .filter((m) => (type === 'user' ? m.is_bot_message === 0 : type === 'bot' ? m.is_bot_message === 1 : true))
      .filter((m) => (searchNorm ? (m.content || '').toLowerCase().includes(searchNorm) : true))
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const total = filtered.length;
    const messages = filtered.slice(offset, offset + limit);
    return jsonOk(c, { messages, total, limit, offset });
  });

  r.get('/api/tasks', (c) => {
    const db = getV2ReadonlyDb(cfg);
    if (!hasTable(db, 'scheduled_tasks')) return jsonOk(c, { tasks: [] });
    const tasks = db.prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all();
    return jsonOk(c, { tasks });
  });

  r.get('/api/task-logs', (c) => {
    const db = getV2ReadonlyDb(cfg);
    if (!hasTable(db, 'task_run_logs')) return jsonOk(c, { logs: [] });
    const taskId = c.req.query('taskId') ?? null;
    const limit = Math.min(100, parseInt(c.req.query('limit') ?? '20', 10));
    const logs = taskId
      ? db.prepare(`SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`).all(taskId, limit)
      : db
          .prepare(
            `SELECT trl.*, st.group_folder, st.prompt
         FROM task_run_logs trl
         LEFT JOIN scheduled_tasks st ON st.id = trl.task_id
         ORDER BY trl.run_at DESC LIMIT ?`,
          )
          .all(limit);
    return jsonOk(c, { logs });
  });

  r.get('/api/groups', (c) => {
    const db = getV2ReadonlyDb(cfg);
    const agentGroups = db.prepare(`SELECT * FROM agent_groups ORDER BY name`).all() as Record<string, unknown>[];
    const messagingGroups = db.prepare(`SELECT * FROM messaging_groups ORDER BY name`).all() as Record<string, unknown>[];
    const folders = listGroupFolders(cfg.resolvedGroupsDir);
    const registered = agentGroups.map((g: Record<string, unknown>) => ({
      ...g,
      skills: listSkillsForGroup(cfg, g.folder as string, db),
      claudeMd: (() => {
        const p = path.join(cfg.resolvedGroupsDir, g.folder as string, 'CLAUDE.local.md');
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      })(),
    }));
    return jsonOk(c, { registered, chats: messagingGroups, folders });
  });

  r.get('/api/agents', (c) => {
    const db = getV2ReadonlyDb(cfg);
    const runningSessions = db
      .prepare(
        `SELECT s.id as session_id,
              s.agent_group_id,
              ag.name as agent_name,
              ag.folder as group_folder,
              s.last_active,
              s.container_status
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
        WHERE s.container_status IN ('running','idle')
        ORDER BY s.last_active DESC`,
      )
      .all() as Array<{
        session_id: string;
        agent_group_id: string;
        agent_name: string;
        group_folder: string;
        last_active: string;
        container_status: string;
    }>;

    let active: Array<{
      groupJid: string;
      containerName: string;
      groupFolder: string | null;
      isTaskContainer: false;
      runningTaskId: null;
    }> = runningSessions.map((s) => ({
      groupJid: s.agent_group_id,
      containerName: `nanoclaw-v2-${s.group_folder}`,
      groupFolder: s.group_folder,
      isTaskContainer: false,
      runningTaskId: null,
    }));
    if (active.length === 0) {
      const names = listActiveDockerAgents();
      active = names.map((name) => ({
        groupJid: 'unknown',
        containerName: name,
        groupFolder: null,
        isTaskContainer: false,
        runningTaskId: null,
      }));
    }
    const registered = (
      db
        .prepare(
          `SELECT ag.id, ag.name, ag.folder,
            (SELECT COUNT(*) FROM sessions s2 WHERE s2.agent_group_id = ag.id
             AND s2.container_status IN ('running','idle')) as running_sessions,
            (SELECT MAX(s3.last_active) FROM sessions s3 WHERE s3.agent_group_id = ag.id) as last_active
         FROM agent_groups ag
        ORDER BY ag.name`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
        id: row.id,
        name: row.name,
        folder: row.folder,
        status: Number(row.running_sessions || 0) > 0 ? 'running' : 'idle',
        lastActive: row.last_active || null,
      }));
    return jsonOk(c, {
      active,
      stats: { activeCount: active.length, maxConcurrent: cfg.MAX_CONCURRENT_CONTAINERS, waitingCount: 0 },
      registered,
    });
  });

  r.get('/api/logs', (c) => {
    const file = c.req.query('file') ?? 'main';
    const lines = Math.min(500, parseInt(c.req.query('lines') ?? '200', 10));
    const projectRoot = path.resolve(path.dirname(cfg.v2DbPath), '..');
    const logPaths: Record<string, string> = {
      main: path.join(projectRoot, 'logs', 'nanoclaw.log'),
      error: path.join(projectRoot, 'logs', 'nanoclaw.error.log'),
      setup: path.join(projectRoot, 'logs', 'setup.log'),
    };
    if (file === 'main' && fs.existsSync(cfg.resolvedLogPath)) {
      const raw = tailFile(cfg.resolvedLogPath, lines);
      return jsonOk(c, { lines: raw.map(stripAnsi), file: 'main' });
    }
    const filePath = logPaths[file] ?? logPaths.main;
    const rawLines = tailFile(filePath, lines);
    return jsonOk(c, { lines: rawLines.map(stripAnsi), file });
  });

  r.get('/api/container-logs', (c) => {
    const group = c.req.query('group') ?? 'main';
    const logFile = c.req.query('logFile') ?? null;
    const lines = Math.min(500, parseInt(c.req.query('lines') ?? '200', 10));
    if (logFile) {
      const safeFile = path.basename(logFile);
      const filePath = path.join(cfg.resolvedGroupsDir, group, 'logs', safeFile);
      const rawLines = tailFile(filePath, lines);
      return jsonOk(c, { lines: rawLines.map(stripAnsi), file: safeFile, group });
    }
    const files = listContainerLogFiles(cfg.resolvedGroupsDir, group);
    return jsonOk(c, { files, group });
  });

  r.get('/api/chats', (c) => {
    const db = getV2ReadonlyDb(cfg);
    const chats = db
      .prepare(
        `SELECT platform_id as jid,
                COALESCE(name, platform_id) as name,
                created_at as last_message_time,
                channel_type as channel,
                is_group
           FROM messaging_groups
          WHERE platform_id != '__group_sync__'
          ORDER BY created_at DESC`,
      )
      .all();
    return jsonOk(c, { chats });
  });

  r.get('/api/tokens', (c) => {
    const period = c.req.query('period') ?? 'month';
    const now = new Date();
    let since: string;
    if (period === 'today') {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      since = d.toISOString();
    } else if (period === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      since = d.toISOString();
    } else {
      since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    }
    const local = parseLocalUsage(cfg, since);
    return jsonOk(c, {
      local,
      anthropic: null,
      openai: null,
      period,
      since,
      billingCachedAt: null,
    });
  });

  r.get('/api/quota', async (c) => {
    /** Token/cost on this page comes from local logs + billing (`/api/tokens`). Provider “quota %” is not wired for most vendors (no public limit endpoint or extra OAuth). */
    const notConfigured = { error: 'not_configured' as const };
    const claude = cfg.ANTHROPIC_API_KEY?.trim()
      ? {
          info: 'key_configured' as const,
          message:
            'ANTHROPIC_API_KEY is set. Anthropic does not offer a public API for live “% of rate limit used” in this app—use the token and billing sections on this page and the Anthropic Console for account status.',
        }
      : notConfigured;
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    const codex = openaiKey
      ? {
          info: 'key_configured' as const,
          message:
            'OPENAI_API_KEY is set. Per-window rate limits for Codex/ChatGPT are not fetched here; see platform.openai.com and the billing block below when configured.',
        }
      : notConfigured;
    return jsonOk(c, {
      providers: {
        claude,
        codex,
        gemini: notConfigured,
        cerebras: notConfigured,
        kimi: notConfigured,
        minimax: notConfigured,
        zai: notConfigured,
      },
      cachedAt: Date.now(),
      ttlMs: 60_000,
    });
  });

  r.get('/api/system-graph', (c) => {
    const db = getV2ReadonlyDb(cfg);
    const groups = db
      .prepare(
        `SELECT id as jid, name, folder, 1 as requires_trigger, 0 as is_main FROM agent_groups`,
      )
      .all() as Array<{ jid: string; name: string; folder: string; requires_trigger: number; is_main: number }>;
    const crons = hasTable(db, 'scheduled_tasks')
      ? (db
          .prepare(`SELECT id, group_folder, schedule_type, schedule_value, status, prompt FROM scheduled_tasks`)
          .all() as Array<{
          id: number;
          group_folder: string;
          schedule_type: string;
          schedule_value: string;
          status: string;
          prompt: string;
        }>)
      : [];
    const src = cfg.resolvedSrcDir;
    const wa = fs.existsSync(path.join(src, 'channels', 'whatsapp.ts'));
    const sl = fs.existsSync(path.join(src, 'channels', 'slack.ts'));
    const nodes: unknown[] = [
      { id: 'nanoclaw', label: 'NanoClaw', type: 'hub', description: 'Central orchestrator' },
    ];
    const edges: unknown[] = [];
    if (wa) {
      nodes.push({ id: 'ch-whatsapp', label: 'WhatsApp', type: 'channel' });
      edges.push({ source: 'ch-whatsapp', target: 'nanoclaw' });
    }
    if (sl) {
      nodes.push({ id: 'ch-slack', label: 'Slack', type: 'channel' });
      edges.push({ source: 'ch-slack', target: 'nanoclaw' });
    }
    for (const g of groups) {
      const nodeId = `grp-${g.folder}`;
      nodes.push({
        id: nodeId,
        label: g.name,
        type: 'group',
        folder: g.folder,
        isMain: false,
      });
      edges.push({ source: 'nanoclaw', target: nodeId });
    }
    for (const cr of crons) {
      if (cr.schedule_type !== 'cron' || cr.status !== 'active') continue;
      const nodeId = `cron-${cr.id}`;
      nodes.push({
        id: nodeId,
        label: (cr.prompt || '').slice(0, 40),
        type: 'cron',
        schedule: cr.schedule_value,
        groupFolder: cr.group_folder,
      });
      edges.push({ source: nodeId, target: `grp-${cr.group_folder}` });
    }
    return jsonOk(c, { nodes, edges });
  });

  /** SSE: realtime monitor — align with reference /events */
  r.get('/events', async (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ ts: Date.now() }), event: 'connected' });
      /** Only notify clients when a *new* latest message appears — avoid spamming /api/messages every 1s. */
      let lastNotifiedMessageKey: string | null = null;
      const tick = async () => {
        try {
          const db = getV2ReadonlyDb(cfg);
          const logFile = fs.existsSync(cfg.resolvedLogPath) ? cfg.resolvedLogPath : null;
          if (logFile) {
            const st = fs.statSync(logFile);
            if (st.size > logTailOffset) {
              const buf = Buffer.alloc(st.size - logTailOffset);
              const fd = fs.openSync(logFile, 'r');
              fs.readSync(fd, buf, 0, buf.length, logTailOffset);
              fs.closeSync(fd);
              logTailOffset = st.size;
              const lines = buf
                .toString('utf8')
                .split('\n')
                .filter((l) => l.trim())
                .map(stripAnsi);
              for (const line of lines.slice(-20)) {
                await stream.writeSSE({ data: JSON.stringify({ line }), event: 'log_line' });
              }
            } else if (st.size < logTailOffset) {
              logTailOffset = 0;
            }
          }
          const m = collectV2Messages(cfg, db);
          const latest = m.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0];
          if (latest) {
            const key = `${latest.id}::${latest.timestamp}`;
            if (lastNotifiedMessageKey === null) {
              lastNotifiedMessageKey = key;
            } else if (key !== lastNotifiedMessageKey) {
              lastNotifiedMessageKey = key;
              await stream.writeSSE({ data: JSON.stringify({ timestamp: latest.timestamp }), event: 'new_message' });
            }
          }
          const running = db
            .prepare(
              `SELECT s.id, s.agent_group_id, ag.folder as group_folder FROM sessions s
               JOIN agent_groups ag ON ag.id = s.agent_group_id
               WHERE s.container_status IN ('running','idle')`,
            )
            .all() as { id: string; agent_group_id: string; group_folder: string }[];
          await stream.writeSSE({
            data: JSON.stringify({
              containers: running.map((s) => ({
                groupJid: s.agent_group_id,
                containerName: `nanoclaw-v2-${s.group_folder}`,
                groupFolder: s.group_folder,
                isTaskContainer: false,
                runningTaskId: null,
              })),
              stats: { activeCount: running.length, maxConcurrent: cfg.MAX_CONCURRENT_CONTAINERS, waitingCount: 0 },
            }),
            event: 'agents',
          });
        } catch (e) {
          await stream.writeSSE({ data: JSON.stringify({ error: String(e) }), event: 'error' });
        }
      };
      const iv = setInterval(() => {
        tick().catch(() => undefined);
      }, 1000);
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(iv);
          resolve();
        });
      });
    });
  });

  return r;
}
