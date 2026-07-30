/**
 * NanoClaw brand palette for the terminal.
 *
 * Colors pulled from assets/nanoclaw-logo.png:
 *   brand cyan  ≈ #2BB7CE  — the "Claw" wordmark + mascot body
 *   brand navy  ≈ #171B3B  — the dark logo background + outlines
 *
 * Rendering gates:
 *   - No TTY (piped / redirected) → plain text, no ANSI
 *   - NO_COLOR set               → plain text, no ANSI
 *   - COLORTERM truecolor/24bit  → 24-bit ANSI (exact brand cyan)
 *   - Otherwise                  → kleur's 16-color cyan (closest fallback)
 */
import k from 'kleur';

const USE_ANSI = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TRUECOLOR =
  USE_ANSI &&
  (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');

export function brand(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[38;2;43;183;206m${s}\x1b[0m`;
  return k.cyan(s);
}

export function brandBold(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[1;38;2;43;183;206m${s}\x1b[0m`;
  return k.bold(k.cyan(s));
}

export function brandChip(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) {
    return `\x1b[48;2;43;183;206m\x1b[38;2;23;27;59m\x1b[1m${s}\x1b[0m`;
  }
  return k.bgCyan(k.black(k.bold(s)));
}

/**
 * Wrap text so it fits inside clack's gutter without the terminal's soft
 * wrap breaking the `│ …` bar on long lines. Works on a single string with
 * embedded `\n`s; each logical line is wrapped independently.
 *
 * The `gutter` argument is the total horizontal overhead clack adds for
 * the component the text lives in (e.g. 4 for `p.log.*`'s `│  ` prefix;
 * 6-ish for `p.note`'s box). Caller picks it; we just subtract from
 * `process.stdout.columns` and hard-wrap at word boundaries.
 */
export function wrapForGutter(text: string, gutter: number): string {
  const cols = process.stdout.columns ?? 80;
  const width = Math.max(30, cols - gutter);
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

/**
 * Wrap + dim together. Needed instead of `k.dim(wrapForGutter(...))`
 * because clack resets styling at each line break when rendering
 * multi-line log content — a single outer dim envelope only colors the
 * first line. Applying dim per-line gives each wrapped row its own
 * `\x1b[2m…\x1b[0m` envelope so the whole block reads as one block.
 */
export function dimWrap(text: string, gutter: number): string {
  return wrapForGutter(text, gutter)
    .split('\n')
    .map((line) => k.dim(line))
    .join('\n');
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function wrapLine(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  const words = line.split(' ');
  const rows: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const word of words) {
    const wLen = visibleLength(word);
    if (curLen === 0) {
      cur = word;
      curLen = wLen;
    } else if (curLen + 1 + wLen <= width) {
      cur += ' ' + word;
      curLen += 1 + wLen;
    } else {
      rows.push(cur);
      cur = word;
      curLen = wLen;
    }
  }
  if (cur) rows.push(cur);
  return rows.join('\n');
}
