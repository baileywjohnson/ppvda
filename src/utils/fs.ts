import { mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function tempPath(dir: string, id: string, ext: string): string {
  return join(dir, `${id}.tmp${ext}`);
}

export async function moveFile(src: string, dest: string): Promise<void> {
  await ensureDir(join(dest, '..'));
  await rename(src, dest);
}

export async function fileSize(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}
