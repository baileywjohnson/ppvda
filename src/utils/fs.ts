import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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

const OVERWRITE_CHUNK = 64 * 1024; // 64 KB

/**
 * Securely delete a file by overwriting its contents with random data before
 * unlinking. Prevents forensic recovery of media content from disk.
 */
export async function secureUnlink(filePath: string): Promise<void> {
  try {
    const fh = await open(filePath, 'r+');
    try {
      const { size } = await fh.stat();
      const buf = randomBytes(Math.min(OVERWRITE_CHUNK, Number(size)));
      for (let offset = 0; offset < size; offset += buf.length) {
        const len = Math.min(buf.length, Number(size) - offset);
        await fh.write(buf, 0, len, offset);
      }
      await fh.datasync();
    } finally {
      await fh.close();
    }
  } catch {
    // File may already be gone — fall through to unlink
  }
  await unlink(filePath).catch(() => {});
}
