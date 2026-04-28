import fs from 'node:fs';
import path from 'node:path';

export function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function fileMtimeSafe(filePath: string): string | null {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

export function tailFile(filePath: string, numLines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const CHUNK = 65536;
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return [];
    let pos = size;
    let text = '';
    while (pos > 0) {
      const chunk = Math.min(CHUNK, pos);
      pos -= chunk;
      const buf = Buffer.alloc(chunk);
      fs.readSync(fd, buf, 0, chunk, pos);
      text = buf.toString('utf8') + text;
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length > numLines) return lines.slice(-numLines);
    }
    return text
      .split('\n')
      .filter((l) => l.trim())
      .slice(-numLines);
  } finally {
    fs.closeSync(fd);
  }
}

export function listGroupFolders(groupsDir: string): string[] {
  if (!fs.existsSync(groupsDir)) return [];
  return fs.readdirSync(groupsDir).filter((f) => fs.statSync(path.join(groupsDir, f)).isDirectory());
}

export function listContainerLogFiles(groupsDir: string, groupFolder: string): string[] {
  const dir = path.join(groupsDir, groupFolder, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, 20);
}
