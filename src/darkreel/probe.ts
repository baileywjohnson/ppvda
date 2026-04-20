import { spawn } from 'node:child_process';

// Local-file probe for the Darkreel upload path. Different from
// src/downloader/probe.ts (which takes URLs and uses network proxies) —
// this one runs against a file we just wrote to disk ourselves, so SSRF
// concerns don't apply.
//
// Output is strictly bounded (1 MB) so a crafted media file can't exhaust
// memory via pathological ffprobe output. Every failure mode (timeout,
// non-zero exit, JSON parse, oversized output, ffprobe not installed)
// resolves to {} — upload continues with minimal metadata.

export interface LocalProbeResult {
  width?: number;
  height?: number;
  duration?: number;
}

const PROBE_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 1 << 20; // 1 MB cap on ffprobe stdout

/**
 * Probe a local media file for width, height, and duration. Best-effort:
 * returns {} if ffprobe is missing, times out, or emits unparseable output.
 *
 * ffmpegPath is used to derive the ffprobe path; if it's a bare `ffmpeg`,
 * we fall back to `ffprobe` on PATH.
 */
export async function probeLocalFile(
  filePath: string,
  ffmpegPath: string,
): Promise<LocalProbeResult> {
  const probeBinary = ffmpegPath.endsWith('ffmpeg')
    ? ffmpegPath.slice(0, -6) + 'ffprobe'
    : 'ffprobe';

  return new Promise<LocalProbeResult>((resolve) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const proc = spawn(probeBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let truncated = false;
    proc.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (out.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        proc.kill('SIGKILL');
        return;
      }
      out += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({});
    }, PROBE_TIMEOUT_MS);

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (truncated || code !== 0) {
        resolve({});
        return;
      }
      try {
        const data = JSON.parse(out) as {
          streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const video = data.streams?.find((s) => s.codec_type === 'video');
        const durationStr = data.format?.duration;
        const duration = durationStr ? parseFloat(durationStr) : undefined;
        resolve({
          width: video?.width,
          height: video?.height,
          duration: duration !== undefined && !Number.isNaN(duration) && duration > 0 ? duration : undefined,
        });
      } catch {
        resolve({});
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

/**
 * Pad a byte array to the next power-of-2 bucket (minimum `minSize`).
 * Trailing padding is ASCII space (0x20) so the wrapped content — a JSON
 * object in our case — decodes cleanly: JSON.parse ignores trailing
 * whitespace per spec. This matches the scheme darkreel-cli and the
 * Darkreel browser upload path use, so SPA decrypts of our uploads
 * interoperate without any unpadding logic on the viewer side.
 *
 * The bucket hides fine-grained payload size from a DB-level observer —
 * a 48-byte metadata and a 512-byte metadata both encode to 512+overhead
 * bytes, so the ciphertext length no longer correlates with, e.g., how
 * long the filename is.
 */
export function padToBucket(data: Uint8Array, minSize: number): Uint8Array {
  let target = minSize;
  while (target < data.length) target *= 2;
  if (target === data.length) return data;
  const padded = new Uint8Array(target);
  padded.set(data, 0);
  padded.fill(0x20, data.length); // ASCII space
  return padded;
}
