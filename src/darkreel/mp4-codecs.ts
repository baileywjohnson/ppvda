// Parse an MP4 / fragmented-MP4 file's moov box and extract MSE-compatible
// codec strings bit-exactly from avcC / hvcC / esds sample description boxes.
//
// Why: MSE's addSourceBuffer / appendBuffer checks the declared codec type
// against the actual stream's sample-entry codec configuration. Safari (and
// sometimes Chrome) strictly matches all three bytes of `avc1.PPCCLL`:
//     PP = profile_idc, CC = profile_compatibility (constraint flags), LL = level_idc
// Our ffprobe-based fallback maps the profile *name* to profile_idc and uses
// "0x00" for the constraint byte, which is wrong for many real encodes
// (typically 0x40 for "no B-frames"). When the declared constraint byte
// doesn't match the actual avcC, MSE refuses the init segment and the user
// sees a "Playback failed: The operation failed for an operation-specific
// reason" error. Downloading and re-uploading via the SPA makes playback
// work because the SPA extracts codecs from the actual avcC with mp4box.js.
//
// This module is the Node-side equivalent — no dependencies, just a box walk.

import { open, type FileHandle } from 'node:fs/promises';

// Only read this much of the file into memory looking for moov. moov is
// near the start of an fMP4 (because of `-movflags empty_moov`) and is
// small (a few KB); reading 2 MB is a generous upper bound that also
// covers the case of a non-fragmented MP4 with moov written to the end
// (where the box walk will simply not find it in this window — acceptable,
// those files don't stream anyway).
const MAX_READ_BYTES = 2 * 1024 * 1024;

export async function extractCodecsFromMP4(filePath: string): Promise<string | null> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(filePath, 'r');
    const stat = await fh.stat();
    const size = Math.min(stat.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    const data = buf.subarray(0, bytesRead);
    const moov = findBox(data, 0, data.length, 'moov');
    if (!moov) return null;
    const codecs: string[] = [];
    // Walk each trak within moov.
    let pos = moov.contentStart;
    while (pos + 8 <= moov.contentEnd) {
      const box = readBoxHeader(data, pos, moov.contentEnd);
      if (!box) break;
      if (box.type === 'trak') {
        const codec = extractCodecFromTrak(data, box.contentStart, box.contentEnd);
        if (codec) codecs.push(codec);
      }
      pos = box.end;
    }
    return codecs.length > 0 ? codecs.join(',') : null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

interface BoxHeader { type: string; contentStart: number; contentEnd: number; end: number; }

function readBoxHeader(data: Buffer, pos: number, limit: number): BoxHeader | null {
  if (pos + 8 > limit) return null;
  const rawSize = data.readUInt32BE(pos);
  const type = data.subarray(pos + 4, pos + 8).toString('latin1');
  let contentStart = pos + 8;
  let boxSize: number;
  if (rawSize === 1) {
    // 64-bit largesize. JS numbers are safe up to 2^53; moov/trak/etc. are
    // never anywhere near that, but guard anyway.
    if (pos + 16 > limit) return null;
    const hi = data.readUInt32BE(pos + 8);
    const lo = data.readUInt32BE(pos + 12);
    boxSize = hi * 0x100000000 + lo;
    contentStart = pos + 16;
  } else if (rawSize === 0) {
    boxSize = limit - pos;
  } else {
    boxSize = rawSize;
  }
  if (boxSize < 8) return null;
  const end = pos + boxSize;
  if (end > limit) return null;
  return { type, contentStart, contentEnd: end, end };
}

function findBox(data: Buffer, start: number, end: number, wantType: string): BoxHeader | null {
  let pos = start;
  while (pos + 8 <= end) {
    const box = readBoxHeader(data, pos, end);
    if (!box) return null;
    if (box.type === wantType) return box;
    pos = box.end;
  }
  return null;
}

function findBoxInContainer(data: Buffer, start: number, end: number, path: string[]): BoxHeader | null {
  let curStart = start;
  let curEnd = end;
  for (let i = 0; i < path.length; i++) {
    const box = findBox(data, curStart, curEnd, path[i]);
    if (!box) return null;
    if (i === path.length - 1) return box;
    curStart = box.contentStart;
    curEnd = box.contentEnd;
  }
  return null;
}

// Walk trak → mdia → minf → stbl → stsd, then inspect the first sample entry.
function extractCodecFromTrak(data: Buffer, trakStart: number, trakEnd: number): string | null {
  const stsd = findBoxInContainer(data, trakStart, trakEnd, ['mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) return null;
  // stsd layout: FullBox header (version=1+flags=3) + entry_count(4) + entries...
  const entriesStart = stsd.contentStart + 8; // skip version/flags + entry_count
  if (entriesStart + 8 > stsd.contentEnd) return null;
  const entry = readBoxHeader(data, entriesStart, stsd.contentEnd);
  if (!entry) return null;
  switch (entry.type) {
    case 'avc1':
    case 'avc3':
      return buildAvcCodecString(data, entry);
    case 'hvc1':
    case 'hev1':
      return buildHevcCodecString(data, entry);
    case 'mp4a':
      return buildAacCodecString(data, entry);
    case 'av01':
      return buildAv1CodecString(data, entry);
    default:
      // Unknown sample entry type. Let the caller decide whether to fall back.
      return null;
  }
}

// VisualSampleEntry header is 78 bytes before child boxes start:
//   SampleEntry base (6 reserved + 2 data_ref_idx) = 8
//   VisualSampleEntry fields                       = 70
//   = 78 bytes from entry.contentStart.
const VISUAL_SAMPLE_ENTRY_HEADER = 78;
// AudioSampleEntry header is 28 bytes before child boxes:
//   SampleEntry base (6 reserved + 2 data_ref_idx) = 8
//   AudioSampleEntry fields (8 reserved + 2 channels + 2 samplesize
//     + 2 pre_defined + 2 reserved + 4 samplerate) = 20
//   = 28 bytes from entry.contentStart. Note: mp4a V1 entries have extra
//   fields after this but we only need to reach the first child box, which
//   on V0 (the common case) sits at offset 28.
const AUDIO_SAMPLE_ENTRY_HEADER = 28;

function buildAvcCodecString(data: Buffer, entry: BoxHeader): string | null {
  const childStart = entry.contentStart + VISUAL_SAMPLE_ENTRY_HEADER;
  const avcC = findBox(data, childStart, entry.contentEnd, 'avcC');
  if (!avcC) return null;
  // avcC contents: configurationVersion(1) + AVCProfileIndication(1)
  //                + profile_compatibility(1) + AVCLevelIndication(1) + ...
  if (avcC.contentStart + 4 > avcC.contentEnd) return null;
  const profile = data[avcC.contentStart + 1];
  const compat = data[avcC.contentStart + 2];
  const level = data[avcC.contentStart + 3];
  const tag = entry.type; // avc1 or avc3
  return `${tag}.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
}

function buildHevcCodecString(data: Buffer, entry: BoxHeader): string | null {
  const childStart = entry.contentStart + VISUAL_SAMPLE_ENTRY_HEADER;
  const hvcC = findBox(data, childStart, entry.contentEnd, 'hvcC');
  if (!hvcC) return null;
  // hvcC layout (ISO/IEC 14496-15 §8.3.3.1.2):
  //   configurationVersion(1)
  //   general_profile_space(2)|general_tier_flag(1)|general_profile_idc(5)
  //   general_profile_compatibility_flags(4)
  //   general_constraint_indicator_flags(6)
  //   general_level_idc(1)
  //   ... (rest not needed for codec string)
  const cs = hvcC.contentStart;
  if (cs + 13 > hvcC.contentEnd) return null;
  const byte1 = data[cs + 1];
  const profileSpace = (byte1 >> 6) & 0x03;
  const tierFlag = (byte1 >> 5) & 0x01;
  const profileIdc = byte1 & 0x1f;
  const profileCompat = data.readUInt32BE(cs + 2);
  // Six bytes of constraint flags, big-endian hex with trailing-zero compression
  const constraint = data.subarray(cs + 6, cs + 12);
  const levelIdc = data[cs + 12];
  const spaceChar = ['', 'A', 'B', 'C', 'D'][profileSpace] ?? '';
  // Reverse-bit profile compatibility flags per ISO/IEC 14496-15
  const reversedCompat = reverseBits32(profileCompat);
  const constraintStr = hexTrimTrailingZeros(constraint);
  return `${entry.type}.${spaceChar}${profileIdc}.${reversedCompat.toString(16).toUpperCase()}.${tierFlag ? 'H' : 'L'}${levelIdc}${constraintStr ? '.' + constraintStr : ''}`;
}

function buildAacCodecString(data: Buffer, entry: BoxHeader): string | null {
  const childStart = entry.contentStart + AUDIO_SAMPLE_ENTRY_HEADER;
  const esds = findBox(data, childStart, entry.contentEnd, 'esds');
  if (!esds) return null;
  // esds is a FullBox (version+flags = 4 bytes) containing an ES_Descriptor.
  // Rather than fully parse the MPEG-4 descriptor tree, scan for the
  // DecoderSpecificInfo tag (0x05) and read its first byte: audio object
  // type is the top 5 bits (1=Main, 2=LC, 5=HE-AAC/SBR, 29=HE-AAC v2/PS).
  const start = esds.contentStart + 4; // skip FullBox header
  const end = esds.contentEnd;
  for (let i = start; i < end - 2; i++) {
    if (data[i] === 0x05) {
      // Length field uses 7-bit-per-byte encoding; skip it.
      let j = i + 1;
      while (j < end && (data[j] & 0x80) !== 0) j++;
      j++; // final length byte
      if (j >= end) break;
      const byte0 = data[j];
      let audioObjectType = (byte0 >> 3) & 0x1f;
      if (audioObjectType === 31 && j + 1 < end) {
        // Extended AOT: next 6 bits + 32
        const byte1 = data[j + 1];
        audioObjectType = 32 + (((byte0 & 0x07) << 3) | ((byte1 >> 5) & 0x07));
      }
      return `mp4a.40.${audioObjectType}`;
    }
  }
  // Fallback for mp4a without a recoverable ASC: assume AAC-LC.
  return 'mp4a.40.2';
}

function buildAv1CodecString(data: Buffer, entry: BoxHeader): string | null {
  const childStart = entry.contentStart + VISUAL_SAMPLE_ENTRY_HEADER;
  const av1C = findBox(data, childStart, entry.contentEnd, 'av1C');
  if (!av1C) return null;
  if (av1C.contentStart + 4 > av1C.contentEnd) return null;
  // av1C layout: marker|version(1), profile|level(1), tier|bit_depth|...(1), ...
  const byte1 = data[av1C.contentStart + 1];
  const byte2 = data[av1C.contentStart + 2];
  const profile = (byte1 >> 5) & 0x07;
  const level = byte1 & 0x1f;
  const tier = (byte2 >> 7) & 0x01;
  const highBitdepth = (byte2 >> 6) & 0x01;
  const twelveBit = (byte2 >> 5) & 0x01;
  const bitDepth = profile === 2 && highBitdepth ? (twelveBit ? 12 : 10) : highBitdepth ? 10 : 8;
  return `av01.${profile}.${level.toString().padStart(2, '0')}${tier ? 'H' : 'M'}.${bitDepth.toString().padStart(2, '0')}`;
}

function hex2(n: number): string { return n.toString(16).padStart(2, '0'); }

function reverseBits32(n: number): number {
  // reverse-bit-order a 32-bit integer as required by HEVC profile compatibility
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | ((n >>> i) & 1);
  }
  return r >>> 0;
}

function hexTrimTrailingZeros(bytes: Buffer): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  if (end === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < end; i++) parts.push(bytes[i].toString(16).toUpperCase().padStart(2, '0'));
  return parts.join('.');
}
