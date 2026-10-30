import { REEL_LIMITS, reelRefContentType, reelRefs, type ReelTimeline } from './reel';

/**
 * The files of a clip, judged by their bytes rather than their names or headers: each picture must be a still WebP,
 * PNG or JPEG of the size its step says, each spoken line an MP3. Used by the workspace runtime as it makes a clip and
 * again by the control plane before it keeps one, which trusts nothing the runtime says.
 */

export type StillInfo = { contentType: 'image/webp' | 'image/png' | 'image/jpeg'; width: number; height: number };

const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) => u16be(bytes, at) * 0x10000 + u16be(bytes, at + 2);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** A still picture's type and size, or null when the bytes are not one (an animated WebP is not a still). */
export function stillInfo(bytes: Uint8Array): StillInfo | null {
  if (bytes.length < 32) {
    return null;
  }
  if (u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a && ascii(bytes, 12, 4) === 'IHDR') {
    return { contentType: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { contentType: 'image/webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const width = 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!);
      const height = 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | ((bytes[22]! & 0xc0) >> 6));
      return { contentType: 'image/webp', width, height };
    }
    if (chunk === 'VP8X' && (bytes[20]! & 0x02) === 0) {
      return { contentType: 'image/webp', width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
    }
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        return null;
      }
      const marker = bytes[at + 1]!;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2;
        continue;
      }
      // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { contentType: 'image/jpeg', width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
      }
      at += 2 + u16be(bytes, at + 2);
    }
  }
  return null;
}

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** Sample rates by MPEG version: 1, 2 and 2.5. */
const MP3_SAMPLE_RATES_V1 = [44100, 48000, 32000];
const MP3_SAMPLE_RATES_V2 = [22050, 24000, 16000];
const MP3_SAMPLE_RATES_V25 = [11025, 12000, 8000];

/** How long an MP3 (MPEG audio layer III) plays, in seconds, from its frames; null when the bytes are not one. */
export function mp3Seconds(bytes: Uint8Array): number | null {
  let at = 0;
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === 'ID3') {
    const size =
      ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    at = 10 + size + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
  }
  const end = bytes.length >= 128 && ascii(bytes, bytes.length - 128, 3) === 'TAG' ? bytes.length - 128 : bytes.length;
  const audioStart = at;
  let seconds = 0;
  let frames = 0;
  while (at + 4 <= end) {
    const version = (bytes[at + 1]! >> 3) & 0x03;
    const layer = (bytes[at + 1]! >> 1) & 0x03;
    const bitrateIndex = bytes[at + 2]! >> 4;
    const rateIndex = (bytes[at + 2]! >> 2) & 0x03;
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || rateIndex === 3) {
      break;
    }
    const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex];
    const sampleRate = (
      version === 3 ? MP3_SAMPLE_RATES_V1 : version === 2 ? MP3_SAMPLE_RATES_V2 : MP3_SAMPLE_RATES_V25
    )[rateIndex]!;
    if (!bitrate) {
      break;
    }
    const padding = (bytes[at + 2]! >> 1) & 0x01;
    const length = Math.floor(((version === 3 ? 144_000 : 72_000) * bitrate) / sampleRate) + padding;
    seconds += (version === 3 ? 1152 : 576) / sampleRate;
    frames += 1;
    at += length;
  }
  // Nearly all of it must be frames: a few stray bytes at the end are tolerated, anything else is not an MP3.
  return frames >= 2 && at >= end - 4 && at - audioStart > 0 ? seconds : null;
}

/** Why a clip's files don't fit its timeline, in words for the agent, or null when they do. */
export function reelFilesProblem(timeline: ReelTimeline, files: ReadonlyMap<string, Uint8Array>): string | null {
  const refs = reelRefs(timeline);
  if (files.size !== refs.length || refs.some((ref) => !files.has(ref))) {
    return 'The clip’s files are not exactly the ones its timeline names.';
  }
  let total = 0;
  for (const ref of refs) {
    const bytes = files.get(ref)!;
    total += bytes.byteLength;
    const contentType = reelRefContentType(ref);
    if (contentType === 'audio/mpeg') {
      if (bytes.byteLength > REEL_LIMITS.audioBytes || mp3Seconds(bytes) === null) {
        return `${ref} is not a short MP3.`;
      }
      continue;
    }
    const info = stillInfo(bytes);
    if (bytes.byteLength > REEL_LIMITS.stillBytes) {
      return `${ref} is larger than ${REEL_LIMITS.stillBytes / 1024} KB.`;
    }
    if (!info || info.contentType !== contentType) {
      return `${ref} is not a still ${contentType.slice('image/'.length).toUpperCase()} picture.`;
    }
    const sized = timeline.steps.every(
      (step) => step.still !== ref || (step.width === info.width && step.height === info.height),
    );
    if (!sized) {
      return `${ref} is not the size its step says.`;
    }
  }
  return total > REEL_LIMITS.totalBytes ? `The clip is larger than ${REEL_LIMITS.totalBytes / 1024 / 1024} MB.` : null;
}
