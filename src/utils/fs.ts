import { lstat, mkdir, mkdtemp, open, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Prefix for per-job working directories under DOWNLOAD_DIR. */
export const JOB_DIR_PREFIX = 'job-';

/**
 * Create a private (0700), uniquely named working directory for one
 * download. Every file a job produces lives inside it, so two jobs — from
 * the same or different users — can never resolve to the same path.
 */
export async function makeJobDir(parent: string): Promise<string> {
  await ensureDir(parent);
  return mkdtemp(join(parent, JOB_DIR_PREFIX));
}

/**
 * secureUnlink every regular file in `dir`, then remove the directory.
 * Not recursive: job directories are flat. Symlinks are unlinked without
 * being followed.
 */
export async function secureRemoveDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = await lstat(p).catch(() => undefined);
    if (!st) continue;
    if (st.isFile()) await secureUnlink(p);
    else if (!st.isDirectory()) await unlink(p).catch(() => {});
  }
  await rmdir(dir).catch(() => {});
}

/**
 * Remove job directories left behind by a crash or restart. Only touches
 * entries created by makeJobDir, so an operator-chosen DOWNLOAD_DIR that
 * happens to contain other files is left alone.
 */
export async function purgeStaleJobDirs(parent: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return 0;
  }
  let purged = 0;
  for (const name of entries) {
    if (!name.startsWith(JOB_DIR_PREFIX)) continue;
    const p = join(parent, name);
    const st = await lstat(p).catch(() => undefined);
    if (!st?.isDirectory()) continue;
    await secureRemoveDir(p);
    purged++;
  }
  return purged;
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
 * deployment setup — a tmpfs-backed DOWNLOAD_DIR plus full-disk encryption is the
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
