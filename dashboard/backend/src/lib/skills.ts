import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';

export function listSkillsForGroup(cfg: AppConfig, groupFolder: string, db: Database.Database): string[] {
  let agentGroupId: string | null = null;
  const row = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(groupFolder) as
    | { id: string }
    | undefined;
  if (row) agentGroupId = row.id;

  const dirs: string[] = [];
  if (agentGroupId) {
    dirs.push(path.join(cfg.v2SessionsDir, agentGroupId, '.claude-shared', 'skills'));
  }
  const containerSkills = path.join(cfg.repoRoot, 'container', 'skills');
  if (fs.existsSync(containerSkills)) dirs.push(containerSkills);

  const skills = new Set<string>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, f);
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink() || stat.isDirectory()) skills.add(f);
      } catch {
        /* */
      }
    }
  }
  return [...skills].sort();
}
