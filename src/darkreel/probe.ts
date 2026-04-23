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
  // Comma-separated MSE codec string (e.g. "avc1.640028,mp4a.40.2"). Darkreel's
  // SPA passes this to MediaSource.addSourceBuffer — if it's absent or wrong,
  // the SPA falls back to a hardcoded "avc1.64001f,mp4a.40.2" default, and MSE
  // rejects the init segment with OperationError for any video encoded at a
  // different profile/level or with a different audio codec.
  codecs?: string;
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
          streams?: Array<{
            codec_type?: string;
            codec_name?: string;
            profile?: string;
            level?: number;
            width?: number;
            height?: number;
          }>;
          format?: { duration?: string };
        };
        const video = data.streams?.find((s) => s.codec_type === 'video');
        const audio = data.streams?.find((s) => s.codec_type === 'audio');
        const durationStr = data.format?.duration;
        const duration = durationStr ? parseFloat(durationStr) : undefined;
        const codecParts: string[] = [];
        const vCodec = video && buildCodecString(video);
        if (vCodec) codecParts.push(vCodec);
        const aCodec = audio && buildCodecString(audio);
        if (aCodec) codecParts.push(aCodec);
        resolve({
          width: video?.width,
          height: video?.height,
          duration: duration !== undefined && !Number.isNaN(duration) && duration > 0 ? duration : undefined,
          codecs: codecParts.length > 0 ? codecParts.join(',') : undefined,
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

// Build an MSE-compatible codec string from ffprobe stream fields. Profile
// names come from ffmpeg's libavcodec; the mappings below cover the common
// real-world encodes seen in web video. The string format is what appears in
// MediaSource `video/mp4; codecs="..."` type assertions.
//
// For H.264 we use constraint_set_flags = 0x00 which is the most-permissive
// default — real files sometimes encode flags like 0x40 (no-B-frames) but
// browsers typically match on profile+level and ignore the constraint byte.
// For HEVC/AV1/VP9 we fall back to conservative safe strings; exact matches
// would require parsing the stsd box from the mp4 directly.
function buildCodecString(stream: {
  codec_name?: string;
  profile?: string;
  level?: number;
}): string | undefined {
  const name = stream.codec_name;
  const profile = stream.profile;
  const level = stream.level;
  if (!name) return undefined;

  if (name === 'h264') {
    const profileMap: Record<string, number> = {
      'Constrained Baseline': 0x42,
      'Baseline': 0x42,
      'Main': 0x4d,
      'Extended': 0x58,
      'High': 0x64,
      'High 10': 0x6e,
      'High 4:2:2': 0x7a,
      'High 4:4:4 Predictive': 0xf4,
    };
    const pid = profileMap[profile ?? ''] ?? 0x64;
    const lev = typeof level === 'number' && level > 0 ? level : 31;
    return `avc1.${pid.toString(16).padStart(2, '0')}00${lev.toString(16).padStart(2, '0')}`;
  }
  if (name === 'hevc' || name === 'h265') {
    return 'hvc1.1.6.L93.B0';
  }
  if (name === 'aac') {
    const profileMap: Record<string, number> = {
      'LC': 2,
      'HE-AAC': 5,
      'HE-AACv2': 29,
      'Main': 1,
    };
    const obj = profileMap[profile ?? ''] ?? 2;
    return `mp4a.40.${obj}`;
  }
  if (name === 'mp3') return 'mp4a.40.34';
  if (name === 'opus') return 'opus';
  if (name === 'vp9') return 'vp09.00.10.08';
  if (name === 'av1') return 'av01.0.04M.08';
  return undefined;
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
