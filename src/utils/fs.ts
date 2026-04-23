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
 * Overwrite a file with random bytes, datasync, then unlink. Best-effort
 * "secure" delete for downloaded plaintext before it leaves the disk.
 *
 * Caveat — this is NOT forensically sufficient on modern filesystems:
 *
 *   - Copy-on-write FS (Btrfs, ZFS, APFS, XFS with reflinks) allocate a
 *     new block for the overwrite; the original blocks keep the plaintext
 *     until the FS garbage-collects. The overwrite pass is a no-op.
 *   - SSDs / NVMe wear-levelling scatter writes; the "original" LBA may
 *     map to entirely different flash pages than the overwrite.
 *   - Journald / any log-structured FS retains historical page contents.
 *
 * See SECURITY.md ("Temp-file plaintext at rest") for the recommended
 * deployment setup — tmpfs for TEMP_DIR plus full-disk encryption is the
 * posture that actually delivers the property users might read into the
 * function name. On ext4 over a LUKS-encrypted rotational disk, this
 * overwrite is meaningful; elsewhere it's a defence-in-depth speed bump.
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
