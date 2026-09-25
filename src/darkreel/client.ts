import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import { secureUnlink } from '../utils/fs.js';
import { basename, join, dirname } from 'node:path';
import { encryptBlock } from '../crypto/index.js';
import { seal } from './crypto.js';
import { detectMediaType, generateThumbnail, type MediaType } from './thumbnail.js';
import { probeLocalFile, padToBucket } from './probe.js';
import { extractCodecsFromMP4 } from './mp4-codecs.js';
import { remuxToFragmentedMP4 } from '../downloader/ffmpeg.js';
import {
  DarkreelError,
  darkreelPost,
  darkreelPostJson,
  resolveDarkreelTarget,
} from './http.js';

// Native Darkreel client. Replaces the spawn(darkreel-cli) hook with pure
// Node code that speaks the Phase 2 sealed-box upload protocol directly.
// The stored credential is a per-user refresh token + the user's X25519
// public key, not a password. PPVDA cannot decrypt what it uploads, by
// construction: it only holds the public key.
//
// All network I/O goes through ./http.ts, which re-validates the stored
// server URL, pins DNS, and caps response sizes on every call. `admin`
// (read from the DB by the caller) selects the private-host/http policy.

const AES_ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const EXCHANGE_TIMEOUT_MS = 15000;

// The only delegation scope PPVDA accepts. A server that hands back a
// broader scope is not the upload-only delegation the user agreed to.
const UPLOAD_SCOPE = 'upload';

export interface DarkreelConnection {
  serverUrl: string; // origin only (scheme://host[:port])
  userId: string; // the Darkreel-side user ID
  delegationId: string;
  publicKey: Buffer;  // 32-byte raw X25519 pubkey
  refreshToken: string;
}

// Shape checks for fields read from the Darkreel server. The server is
// user-chosen, so its replies are validated like any other untrusted input:
// string types, bounded lengths, and charsets that can't smuggle anything
// into a header or log line.
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;
const ACCESS_TOKEN_RE = /^[A-Za-z0-9_.-]{16,8192}$/;
const PUBLIC_KEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/; // exactly 32 bytes

function field(data: Record<string, unknown>, name: string, re: RegExp): string {
  const v = data[name];
  if (typeof v !== 'string' || !re.test(v)) throw new DarkreelError('BAD_RESPONSE');
  return v;
}

/**
 * Exchange a one-shot authorization code for a durable refresh token.
 * The Darkreel SPA produced the code in its "Authorize an App" flow; the
 * user pasted it into PPVDA. The returned connection's serverUrl is the
 * normalised origin — store that, not the raw input.
 */
export async function exchangeCode(
  serverUrl: string,
  code: string,
  opts: { admin: boolean; signal?: AbortSignal },
): Promise<DarkreelConnection> {
  const target = await resolveDarkreelTarget(serverUrl, opts.admin);
  // Only the status survives a failure. Reflecting the upstream body into
  // the error (and thus into the HTTP response surfaced to an admin who is
  // allowed to target private URLs) would turn this into an SSRF primitive
  // with body-leak — e.g. IMDS `/latest/meta-data/…` text.
  const { status, data } = await darkreelPostJson(
    target, '/api/delegation/exchange', { authorization_code: code }, EXCHANGE_TIMEOUT_MS, opts.signal,
  );
  if (!data) throw new DarkreelError('HTTP_STATUS', status);

  if (data.scope !== UPLOAD_SCOPE) throw new DarkreelError('SCOPE_MISMATCH');
  const publicKey = Buffer.from(field(data, 'public_key', PUBLIC_KEY_B64_RE), 'base64');
  if (publicKey.length !== 32) throw new DarkreelError('BAD_RESPONSE');
  return {
    serverUrl: target.origin.origin,
    userId: field(data, 'user_id', ID_RE),
    delegationId: field(data, 'delegation_id', ID_RE),
    publicKey,
    refreshToken: field(data, 'refresh_token', REFRESH_TOKEN_RE),
  };
}

/**
 * Trade a refresh token for a short-lived upload-scoped JWT.
 * Called right before each batch of uploads. Server-side revocation of the
 * delegation takes effect at this call: once the row is deleted, no new
 * access tokens can be minted.
 */
export async function refreshAccessToken(
  serverUrl: string,
  refreshToken: string,
  opts: { admin: boolean; signal?: AbortSignal },
): Promise<string> {
  const target = await resolveDarkreelTarget(serverUrl, opts.admin);
  const { status, data } = await darkreelPostJson(
    target, '/api/delegation/refresh', { refresh_token: refreshToken }, EXCHANGE_TIMEOUT_MS, opts.signal,
  );
  if (!data) {
    throw new DarkreelError(status === 401 || status === 403 ? 'REVOKED' : 'HTTP_STATUS', status);
  }
  if (data.scope !== UPLOAD_SCOPE) throw new DarkreelError('SCOPE_MISMATCH');
  return field(data, 'access_token', ACCESS_TOKEN_RE);
}

export interface UploadFileOptions {
  conn: DarkreelConnection;
  /** From the DB at call time: admin-connected URLs may be http / private. */
  admin: boolean;
  accessToken: string;
  filePath: string;
  ffmpegPath: string;
  timeoutMs: number;
}

/**
 * Encrypt and upload a single file using the Phase 2 sealed-box protocol.
 *
 * Per-file fresh symmetric keys:
 *   fileKey — encrypts each chunk with AAD = utf8(mediaID) || BE64(chunkIdx)
 *   thumbKey — encrypts the single-chunk thumbnail with AAD = utf8(mediaID) || BE64(0)
 *   metadataKey — encrypts the metadata JSON with AAD = utf8(mediaID)
 *
 * Each of the three keys is sealed to conn.publicKey so only the Darkreel
 * account holder can open them. We generate a client-side mediaID and bind
 * it into every AAD so a server that substitutes chunks across uploads is
 * caught by the AEAD.
 */
export async function uploadFile(opts: UploadFileOptions): Promise<void> {
  const { conn, admin, accessToken, filePath, ffmpegPath, timeoutMs } = opts;

  const mediaID = randomUUID();
  const mediaIDBytes = Buffer.from(mediaID, 'utf-8');
  const fileName = basename(filePath);
  const mediaType = detectMediaType(fileName);

  const initialStat = await stat(filePath);
  if (!initialStat.isFile()) throw new Error('upload source is not a regular file');
  if (initialStat.size === 0) throw new Error('file is empty');

  // For videos, Darkreel's SPA MSE player expects chunk 0 to be the init
  // segment (everything before the first moof) and chunks 1..N to each be
  // one moof+mdat pair. A non-fragmented MP4 (moov at end, one big mdat)
  // has no moof boxes at all — scanFMP4Segments returns a single whole-
  // file segment, the SPA appends it as "init", sees no media chunks to
  // stream, and playback never starts. Direct-downloaded videos (plain
  // MP4 URLs, not HLS/DASH) come through this path unchanged from the
  // origin server, so they're typically non-fragmented.
  //
  // Remux to fMP4 up front if needed. We detect by scanning for moof — if
  // zero moofs, the file needs remuxing. If remux fails (ffmpeg missing,
  // unsupported codec, etc.) we fall back to uploading as non-fragmented,
  // which the SPA handles via its blob-download playback path.
  let uploadPath = filePath;
  let fragmented = false;
  let cleanupRemux: (() => Promise<void>) | null = null;
  if (mediaType === 'video') {
    const initialScan = await scanFMP4Segments(filePath, initialStat.size);
    const alreadyFragmented = initialScan.length > 1; // init + ≥1 media segment
    if (alreadyFragmented) {
      fragmented = true;
    } else {
      const remuxPath = join(dirname(filePath), `.${basename(filePath)}.fmp4.${randomUUID()}`);
      const result = await remuxToFragmentedMP4({
        inputPath: filePath,
        outputPath: remuxPath,
        ffmpegPath,
      });
      if (result.success) {
        uploadPath = remuxPath;
        fragmented = true;
        // A full plaintext copy of the media: overwrite before unlinking,
        // like every other staged file.
        cleanupRemux = () => secureUnlink(remuxPath);
      } else {
        // Remux unavailable — upload as-is so the file is at least saved.
        // The SPA falls back to blob playback (download-then-play) for
        // non-fragmented items.
      }
    }
  }

  try {
  const statRes = await stat(uploadPath);
  const fileSize = statRes.size;

  const segments = fragmented
    ? mergeSegments(await scanFMP4Segments(uploadPath, fileSize), CHUNK_DATA_SIZE)
    : makeFixedSegments(fileSize);
  const chunkCount = segments.length;
  if (chunkCount > 50000) throw new Error(`file too large: ${chunkCount} chunks exceeds server limit`);

  // Three per-file random symmetric keys. Never master-key-derived — always
  // random and sealed to the recipient's public key.
  const fileKey = randomBytes(32);
  const thumbKey = randomBytes(32);
  const metadataKey = randomBytes(32);

  try {
    // Thumbnail. Generate off-disk (ffmpeg for media, placeholder for file).
    const thumbPlain = await generateThumbnail(uploadPath, mediaType, ffmpegPath);
    const thumbEnc = encryptChunk(frame(thumbPlain, true, THUMB_CIPHERTEXT_SIZE), thumbKey, 0, mediaIDBytes);

    // Metadata blob, encrypted under its own key (not the master key) so a
    // delegated client can write metadata without ever holding the master.
    //
    // For images and videos we probe the file with ffprobe so the Darkreel
    // gallery can display width/height/duration alongside the name. Best-
    // effort: a probe failure (no ffprobe, bad file, timeout) just omits
    // the optional fields.
    const meta: Record<string, unknown> = {
      name: fileName,
      media_type: mediaType,
      mime_type: mimeFromExt(fileName) ?? 'application/octet-stream',
      size: fileSize,
      chunk_count: chunkCount,
      chunk_format: CHUNK_FORMAT,
    };
    if (mediaType === 'video' || mediaType === 'image') {
      const info = await probeLocalFile(uploadPath, ffmpegPath);
      if (info.width !== undefined) meta.width = info.width;
      if (info.height !== undefined) meta.height = info.height;
      if (info.duration !== undefined && mediaType === 'video') meta.duration = info.duration;
      // Codec string preference: parse the actual avcC/hvcC/esds bytes from
      // the produced fMP4 first — those give a bit-exact match for MSE (Safari
      // and some Chrome paths strictly check all three bytes of avc1.PPCCLL).
      // Fall back to the ffprobe-derived profile/level mapping only if the
      // box walk fails. The ffprobe path always sets constraint_set_flags to
      // 0x00 which mismatches many real-world encodes (e.g., 0x40 for
      // "no B-frames") and is the root cause of MSE refusing to initialize
      // the SourceBuffer for PPVDA uploads.
      if (mediaType === 'video') {
        const exact = await extractCodecsFromMP4(uploadPath);
        if (exact) meta.codecs = exact;
        else if (info.codecs !== undefined) meta.codecs = info.codecs;
      }
    }
    // Only claim `fragmented: true` when the upload file actually is fMP4
    // (either direct ffmpeg output or a successful post-download remux). If
    // we set this flag on a non-fragmented file, the SPA's MSE path appends
    // the whole file as "init" and playback never starts.
    if (mediaType === 'video' && fragmented) meta.fragmented = true;
    // Pad to a power-of-2 bucket (min 512 B) before encryption. Matches the
    // darkreel-cli / Darkreel-browser scheme: JSON.parse ignores trailing
    // spaces, so the SPA decrypts without any unpadding logic. Bucket
    // hides payload size from DB-level observers — ciphertext length no
    // longer correlates with "how long is the filename" etc.
    const metaPadded = padToBucket(Buffer.from(JSON.stringify(meta), 'utf-8'), 512);
    const metaEnc = encryptBlock(Buffer.from(metaPadded.buffer, metaPadded.byteOffset, metaPadded.byteLength), metadataKey, mediaIDBytes);
    // encryptBlock returns nonce(12) || ct || tag; server wants them split.
    const metadataNonce = metaEnc.subarray(0, 12);
    const metadataCiphertext = metaEnc.subarray(12);

    // Seal each key to the user's public key. Output is SEAL_OVERHEAD + 32
    // = 92 bytes, exactly what the server's Phase 1 upload handler accepts.
    const fileKeySealed = seal(fileKey, conn.publicKey);
    const thumbKeySealed = seal(thumbKey, conn.publicKey);
    const metadataKeySealed = seal(metadataKey, conn.publicKey);

    const metadataJson = JSON.stringify({
      media_id: mediaID,
      chunk_count: chunkCount,
      file_key_sealed: fileKeySealed.toString('base64'),
      thumb_key_sealed: thumbKeySealed.toString('base64'),
      metadata_key_sealed: metadataKeySealed.toString('base64'),
      metadata_enc: metadataCiphertext.toString('base64'),
      metadata_nonce: metadataNonce.toString('base64'),
    });

    // Streamed multipart body: parts are produced as the request pulls them,
    // so at most one chunk of plaintext and one of ciphertext are in memory
    // at a time — not the whole encrypted file. Part order is what Darkreel's
    // handler requires: metadata, thumbnail, then chunk0..chunkN-1.
    const boundary = `----ppvda${randomBytes(16).toString('hex')}`;
    const partHeader = (name: string, filename?: string) => Buffer.from(
      `--${boundary}\r\n` +
      (filename
        ? `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
          'Content-Type: application/octet-stream\r\n'
        : `Content-Disposition: form-data; name="${name}"\r\n`) +
      '\r\n',
      'utf-8',
    );
    const CRLF = Buffer.from('\r\n');

    // A local failure inside the body (e.g. a short read) surfaces through
    // the request as a transport error; remember it to report the real cause.
    let bodyError: Error | undefined;
    async function* multipartBody(): AsyncGenerator<Buffer> {
      try {
        yield partHeader('metadata');
        yield Buffer.from(metadataJson, 'utf-8');
        yield CRLF;

        yield partHeader('thumbnail', 'thumb.enc');
        yield thumbEnc;
        yield CRLF;

        const fd = await open(uploadPath, 'r');
        try {
          for (let i = 0; i < chunkCount; i++) {
            const seg = segments[i];
            const buf = Buffer.alloc(seg.size);
            const { bytesRead } = await fd.read(buf, 0, buf.length, seg.offset);
            if (bytesRead !== buf.length) throw new Error(`short read at chunk ${i}`);
            // The one place a chunk's plaintext is encrypted — as a padded
            // format-2 frame (see frameChunk).
            const framed = frameChunk(buf, i === chunkCount - 1);
            buf.fill(0);
            const enc = encryptChunk(framed, fileKey, i, mediaIDBytes);
            framed.fill(0);
            yield partHeader(`chunk${i}`, `${i}.enc`);
            yield enc;
            yield CRLF;
          }
        } finally {
          await fd.close();
        }

        yield Buffer.from(`--${boundary}--\r\n`, 'utf-8');
      } catch (err) {
        bodyError = err instanceof Error ? err : new Error(String(err));
        throw err;
      }
    }

    const target = await resolveDarkreelTarget(conn.serverUrl, admin);
    let res;
    try {
      res = await darkreelPost(target, '/api/media/upload', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody(),
        timeoutMs,
      });
    } catch (err) {
      throw bodyError ?? err;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new DarkreelError('HTTP_STATUS', res.status);
    }
  } finally {
    fileKey.fill(0);
    thumbKey.fill(0);
    metadataKey.fill(0);
  }
  } finally {
    if (cleanupRemux) await cleanupRemux();
  }
}

// --- internal helpers ---

// Darkreel chunk format 2 (mirrors web/js/crypto.js and darkreel-cli's
// internal/crypto/frame.go). Each chunk's plaintext is a frame
//   version(1)=2 | flags(1, bit0 = last chunk) | u32be data length | data | zero padding
// padded so the ciphertext (nonce + frame + tag) is exactly 1/2/4/8/16 MiB,
// then whole MiB; thumbnails are exactly 256 KiB. Darkreel's server and the
// network then only ever see bucket sizes, never exact chunk lengths, and
// the encrypted last-chunk flag lets readers detect a dropped tail.
const CHUNK_FORMAT = 2;
const FRAME_HEADER = 6;
const GCM_OVERHEAD = 28; // 12-byte nonce + 16-byte tag
const MIB = 1024 * 1024;
// Largest payload that fits the smallest (1 MiB) bucket.
const CHUNK_DATA_SIZE = MIB - GCM_OVERHEAD - FRAME_HEADER;
const THUMB_CIPHERTEXT_SIZE = 256 * 1024;

function chunkCiphertextSize(dataLen: number): number {
  const need = dataLen + FRAME_HEADER + GCM_OVERHEAD;
  for (const b of [1, 2, 4, 8, 16]) {
    if (need <= b * MIB) return b * MIB;
  }
  return Math.ceil(need / MIB) * MIB;
}

function frame(data: Buffer, isLast: boolean, ciphertextSize: number): Buffer {
  const frameLen = ciphertextSize - GCM_OVERHEAD;
  if (data.length + FRAME_HEADER > frameLen) throw new Error('chunk too large for its frame');
  const out = Buffer.alloc(frameLen);
  out[0] = CHUNK_FORMAT;
  out[1] = isLast ? 1 : 0;
  out.writeUInt32BE(data.length, 2);
  data.copy(out, FRAME_HEADER);
  return out;
}

function frameChunk(data: Buffer, isLast: boolean): Buffer {
  return frame(data, isLast, chunkCiphertextSize(data.length));
}

// Join consecutive fMP4 fragments into chunks of at most maxLen bytes so each
// fills a bucket, instead of every small fragment being padded to 1 MiB on
// its own. The init segment stays separate; an oversized fragment gets its
// own chunk.
function mergeSegments(segs: Segment[], maxLen: number): Segment[] {
  if (segs.length <= 2) return segs;
  const out: Segment[] = [segs[0]];
  let cur = { ...segs[1] };
  for (const s of segs.slice(2)) {
    if (s.offset === cur.offset + cur.size && cur.size + s.size <= maxLen) {
      cur.size += s.size;
      continue;
    }
    out.push(cur);
    cur = { ...s };
  }
  out.push(cur);
  return out;
}

function encryptChunk(plaintext: Buffer, key: Buffer, chunkIndex: number, mediaIDBytes: Buffer): Buffer {
  // AAD = utf8(mediaID) || BigEndian(uint64(chunkIndex))
  const aad = Buffer.alloc(mediaIDBytes.length + 8);
  mediaIDBytes.copy(aad, 0);
  aad.writeBigUInt64BE(BigInt(chunkIndex), mediaIDBytes.length);

  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(AES_ALGO, key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Wire format: nonce(12) || ct || tag(16).
  return Buffer.concat([nonce, enc, tag]);
}

function mimeFromExt(filename: string): string | undefined {
  const ext = filename.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!ext) return undefined;
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  };
  return map[ext];
}

// Re-export so callers can import MediaType alongside uploadFile without
// pulling in ./thumbnail directly.
export type { MediaType };

interface Segment { offset: number; size: number; }

function makeFixedSegments(fileSize: number): Segment[] {
  const out: Segment[] = [];
  for (let off = 0; off < fileSize; off += CHUNK_DATA_SIZE) {
    out.push({ offset: off, size: Math.min(CHUNK_DATA_SIZE, fileSize - off) });
  }
  return out.length === 0 ? [{ offset: 0, size: 0 }] : out;
}

// Scan an fMP4 file for `moof` box offsets and return:
//   segment 0    = everything before the first moof (ftyp + moov init segment)
//   segment N≥1  = bytes [moof_N, moof_{N+1}) — i.e. one moof + following mdat
// Falls back to a single whole-file segment if no moof is found (i.e. the
// remux produced a non-fragmented MP4 — shouldn't happen with our ffmpeg
// flags but handled defensively so a malformed input doesn't break upload).
async function scanFMP4Segments(filePath: string, fileSize: number): Promise<Segment[]> {
  const fd = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const moofOffsets: number[] = [];
    let pos = 0;
    while (pos < fileSize) {
      const readLen = Math.min(16, fileSize - pos);
      if (readLen < 8) break;
      const { bytesRead } = await fd.read(header, 0, readLen, pos);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const boxType = header.slice(4, 8).toString('ascii');
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        // 64-bit extended size — JS numbers are safe up to 2^53, fMP4 files
        // never approach that so a plain Number is fine.
        const hi = header.readUInt32BE(8);
        const lo = header.readUInt32BE(12);
        boxSize = hi * 0x100000000 + lo;
      } else if (boxSize === 0) {
        boxSize = fileSize - pos;
      }
      if (boxSize < 8 || pos + boxSize > fileSize) break;
      if (boxType === 'moof') moofOffsets.push(pos);
      pos += boxSize;
    }
    if (moofOffsets.length === 0) return [{ offset: 0, size: fileSize }];
    const segments: Segment[] = [{ offset: 0, size: moofOffsets[0] }];
    for (let i = 0; i < moofOffsets.length; i++) {
      const start = moofOffsets[i];
      const end = i + 1 < moofOffsets.length ? moofOffsets[i + 1] : fileSize;
      segments.push({ offset: start, size: end - start });
    }
    return segments;
  } finally {
    await fd.close();
  }
}
