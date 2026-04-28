import { execSync } from 'node:child_process';

export function listActiveDockerAgents(): string[] {
  try {
    const out = execSync(`docker ps --filter "label=nanoclaw-install" --format "{{.Names}}" 2>/dev/null`, {
      encoding: 'utf8',
    }).trim();
    return out
      ? out
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}
