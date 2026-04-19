import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Darkreel-compatible thumbnail generator. Produces a JPEG between ~10 KB and
// ~250 KB. For videos we grab a frame at t=1s; for images we scale to 320px.
// For non-media files we return a 1x1 placeholder so the gallery has
// something to display without special-casing the uploader.

const PLACEHOLDER_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x7f, 0xff, 0xd9,
]);

export type MediaType = 'image' | 'video' | 'file';

export function detectMediaType(filename: string): MediaType {
  const lower = filename.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|avif|bmp)$/.test(lower)) return 'image';
  if (/\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|ts|m3u8)$/.test(lower)) return 'video';
  return 'file';
}

/**
 * Generate a 320px JPEG thumbnail from a media file. Runs ffmpeg out of
 * process with a short timeout; on any failure returns the placeholder so
 * the upload pipeline never stalls on bad input.
 */
export async function generateThumbnail(
  filePath: string,
  mediaType: MediaType,
  ffmpegPath: string,
): Promise<Buffer> {
  if (mediaType === 'file') return PLACEHOLDER_JPEG;

  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'ppvda-thumb-'));
    const out = join(workDir, 'thumb.jpg');

    const args = mediaType === 'video'
      ? ['-nostdin', '-y', '-v', 'error', '-ss', '1', '-i', filePath, '-vframes', '1',
         '-vf', 'scale=320:-1', '-q:v', '5', out]
      : ['-nostdin', '-y', '-v', 'error', '-i', filePath,
         '-vf', 'scale=320:-1', '-q:v', '5', out];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 15000);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}`));
      });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    const buf = await readFile(out);
    if (buf.length === 0) return PLACEHOLDER_JPEG;
    return buf;
  } catch {
    return PLACEHOLDER_JPEG;
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
