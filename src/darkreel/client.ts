import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import { basename } from 'node:path';
import { encryptBlock } from '../crypto/index.js';
import { seal } from './crypto.js';
import { detectMediaType, generateThumbnail, type MediaType } from './thumbnail.js';
import { probeLocalFile, padToBucket } from './probe.js';

// Native Darkreel client. Replaces the spawn(darkreel-cli) hook with pure
// Node code that speaks the Phase 2 sealed-box upload protocol directly.
// The stored credential is a per-user refresh token + the user's X25519
// public key, not a password. PPVDA cannot decrypt what it uploads, by
// construction: it only holds the public key.

const CHUNK_SIZE = 1 << 20; // 1 MB, matches Darkreel server
const AES_ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;

export interface DarkreelConnection {
  serverUrl: string;
  userId: string; // the Darkreel-side user ID
  delegationId: string;
  publicKey: Buffer;  // 32-byte raw X25519 pubkey
  refreshToken: string;
}

interface ExchangeResponse {
  user_id: string;
  public_key: string;
  refresh_token: string;
  delegation_id: string;
  scope: string;
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/**
 * Exchange a one-shot authorization code for a durable refresh token.
 * The Darkreel SPA produced the code in its "Authorize an App" flow; the
 * user pasted it into PPVDA. Both code and server URL come from the user,
 * so validate minimally and let the server's own rate limiter handle the
 * rest.
 */
export async function exchangeCode(
  serverUrl: string,
  code: string,
  abortSignal?: AbortSignal,
): Promise<DarkreelConnection> {
  const url = serverUrl.replace(/\/+$/, '') + '/api/delegation/exchange';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization_code: code }),
    signal: abortSignal ?? AbortSignal.timeout(15000),
    redirect: 'error', // refuse redirects — the server shouldn't send any
  });
  if (!res.ok) {
    // Server returns identical text for "not found" vs "expired" so we pass
    // the same message through. No leakage of distinguishers.
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Authorization code exchange failed');
  }
  const data = (await res.json()) as ExchangeResponse;
  const publicKey = Buffer.from(data.public_key, 'base64');
  if (publicKey.length !== 32) {
    throw new Error('Darkreel returned an unexpected public key length');
  }
  return {
    serverUrl,
    userId: data.user_id,
    delegationId: data.delegation_id,
    publicKey,
    refreshToken: data.refresh_token,
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
  abortSignal?: AbortSignal,
): Promise<string> {
  const url = serverUrl.replace(/\/+$/, '') + '/api/delegation/refresh';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: abortSignal ?? AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!res.ok) {
    throw new Error('Refresh token rejected by Darkreel — the delegation may have been revoked');
  }
  const data = (await res.json()) as RefreshResponse;
  return data.access_token;
}

export interface UploadFileOptions {
  conn: DarkreelConnection;
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
  const { conn, accessToken, filePath, ffmpegPath, timeoutMs } = opts;

  const mediaID = randomUUID();
  const mediaIDBytes = Buffer.from(mediaID, 'utf-8');
  const fileName = basename(filePath);
  const mediaType = detectMediaType(fileName);

  const statRes = await stat(filePath);
  if (!statRes.isFile()) throw new Error('upload source is not a regular file');
  const fileSize = statRes.size;
  if (fileSize === 0) throw new Error('file is empty');

  // For videos, align chunk boundaries to fMP4 segments (init then each
  // moof+mdat pair). Darkreel's SPA MSE player treats chunk 0 as the init
  // segment and assumes each subsequent chunk is a complete media segment —
  // fixed-size splitting breaks that contract and stalls playback after the
  // first segment. Mirrors darkreel-cli's scanFMP4Segments.
  const segments = mediaType === 'video'
    ? await scanFMP4Segments(filePath, fileSize)
    : makeFixedSegments(fileSize);
  const chunkCount = segments.length;
  if (chunkCount > 50000) throw new Error(`file too large: ${chunkCount} chunks exceeds server limit`);

  // Three per-file random symmetric keys. Never master-key-derived — always
  // random and sealed to the recipient's public key.
  const fileKey = randomBytes(32);
  const thumbKey = randomBytes(32);
  const metadataKey = randomBytes(32);
  const hashNonce = randomBytes(32); // server stores for dedup-resistance

  try {
    // Thumbnail. Generate off-disk (ffmpeg for media, placeholder for file).
    const thumbPlain = await generateThumbnail(filePath, mediaType, ffmpegPath);
    const thumbEnc = encryptChunk(thumbPlain, thumbKey, 0, mediaIDBytes);

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
    };
    if (mediaType === 'video' || mediaType === 'image') {
      const info = await probeLocalFile(filePath, ffmpegPath);
      if (info.width !== undefined) meta.width = info.width;
      if (info.height !== undefined) meta.height = info.height;
      if (info.duration !== undefined && mediaType === 'video') meta.duration = info.duration;
    }
    // Videos go out as fragmented MP4 (see downloader/ffmpeg.ts), so the SPA
    // viewer can play them via MSE instead of downloading the whole file first.
    if (mediaType === 'video') meta.fragmented = true;
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

    // Streaming multipart assembly. Encrypt each chunk as we read it so only
    // one chunk of plaintext is in memory at a time for large files.
    const form = new FormData();
    form.set('metadata', JSON.stringify({
      media_id: mediaID,
      chunk_count: chunkCount,
      file_key_sealed: fileKeySealed.toString('base64'),
      thumb_key_sealed: thumbKeySealed.toString('base64'),
      metadata_key_sealed: metadataKeySealed.toString('base64'),
      hash_nonce: hashNonce.toString('base64'),
      metadata_enc: metadataCiphertext.toString('base64'),
      metadata_nonce: metadataNonce.toString('base64'),
    }));
    form.set('thumbnail', new Blob([bufferToU8(thumbEnc)], { type: 'application/octet-stream' }), 'thumb.enc');

    const fd = await open(filePath, 'r');
    try {
      for (let i = 0; i < chunkCount; i++) {
        const seg = segments[i];
        const buf = Buffer.alloc(seg.size);
        const { bytesRead } = await fd.read(buf, 0, buf.length, seg.offset);
        if (bytesRead !== buf.length) throw new Error(`short read at chunk ${i}`);
        const enc = encryptChunk(buf, fileKey, i, mediaIDBytes);
        form.set(`chunk${i}`, new Blob([bufferToU8(enc)], { type: 'application/octet-stream' }), `${i}.enc`);
        buf.fill(0);
      }
    } finally {
      await fd.close();
    }

    const res = await fetch(conn.serverUrl.replace(/\/+$/, '') + '/api/media/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Darkreel upload failed (${res.status}): ${text.slice(0, 200)}`);
    }
  } finally {
    fileKey.fill(0);
    thumbKey.fill(0);
    metadataKey.fill(0);
  }
}

// --- internal helpers ---

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

// Node's Buffer is typed as Uint8Array<ArrayBufferLike> (buffer may be a
// SharedArrayBuffer), but DOM BlobPart requires Uint8Array<ArrayBuffer>.
// Hand Blob a freshly-allocated ArrayBuffer view to satisfy the stricter
// type. One memcpy per chunk — throughput bottleneck is network + GCM.
function bufferToU8(buf: Buffer): Uint8Array<ArrayBuffer> {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new Uint8Array(ab);
}

interface Segment { offset: number; size: number; }

function makeFixedSegments(fileSize: number): Segment[] {
  const out: Segment[] = [];
  for (let off = 0; off < fileSize; off += CHUNK_SIZE) {
    out.push({ offset: off, size: Math.min(CHUNK_SIZE, fileSize - off) });
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
