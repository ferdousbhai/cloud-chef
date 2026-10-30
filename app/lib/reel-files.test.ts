import { describe, expect, it } from 'vitest';
import { reelTimelineSchema, type ReelTimeline } from './reel';
import { mp3Seconds, reelFilesProblem, stillInfo } from './reel-files';

/** The first bytes of a PNG of `width` by `height`, which is all `stillInfo` reads. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A lossy WebP's header, or an extended one with its animation flag. */
function webp(width: number, height: number, kind: 'VP8 ' | 'VP8X' = 'VP8 ', animated = false): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  bytes.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [...'WEBP'].map((c) => c.charCodeAt(0)),
    8,
  );
  bytes.set(
    [...kind].map((c) => c.charCodeAt(0)),
    12,
  );
  if (kind === 'VP8 ') {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else {
    bytes[20] = animated ? 0x02 : 0;
    view.setUint16(24, width - 1, true);
    view.setUint16(27, height - 1, true);
  }
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment of 16 bytes, then a baseline start of frame.
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  const sof = 2 + 2 + 16;
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff], sof);
  return bytes;
}

/** `frames` MPEG-2 layer III frames at 48 kbit/s, 24 kHz: 144 bytes and 24 ms each. */
function mp3(frames: number): Uint8Array {
  const bytes = new Uint8Array(frames * 144);
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.set([0xff, 0xf3, 0x64, 0x00], frame * 144);
  }
  return bytes;
}

describe('a clip’s files', () => {
  it('knows a still picture and its size by its bytes', () => {
    expect(stillInfo(png(1280, 800))).toEqual({ contentType: 'image/png', width: 1280, height: 800 });
    expect(stillInfo(webp(390, 844))).toEqual({ contentType: 'image/webp', width: 390, height: 844 });
    expect(stillInfo(webp(1280, 800, 'VP8X'))).toEqual({ contentType: 'image/webp', width: 1280, height: 800 });
    expect(stillInfo(jpeg(1280, 800))).toEqual({ contentType: 'image/jpeg', width: 1280, height: 800 });
    expect(stillInfo(webp(1280, 800, 'VP8X', true))).toBeNull();
    expect(stillInfo(new TextEncoder().encode('<svg onload="alert(1)"></svg>'.padEnd(64)))).toBeNull();
  });

  it('measures an MP3 by its frames', () => {
    expect(mp3Seconds(mp3(125))).toBeCloseTo(3, 5);
    expect(mp3Seconds(new TextEncoder().encode('not sound at all, only words'.repeat(10)))).toBeNull();
  });

  it('takes only the files its timeline names, of the type and size it says', () => {
    const timeline: ReelTimeline = reelTimelineSchema.parse({
      version: 1,
      steps: [
        { still: 's0.webp', width: 1280, height: 800, seconds: 3, caption: 'Add a recipe', audio: 'a0.mpeg' },
        { still: 's1.png', width: 1280, height: 800, seconds: 2, tap: { x: 0.5, y: 0.4, at: 1 } },
      ],
    });
    const files = new Map([
      ['s0.webp', webp(1280, 800)],
      ['s1.png', png(1280, 800)],
      ['a0.mpeg', mp3(100)],
    ]);
    expect(reelFilesProblem(timeline, files)).toBeNull();
    expect(reelFilesProblem(timeline, new Map([...files, ['s1.png', webp(1280, 800)]]))).toMatch(/not a still PNG/u);
    expect(reelFilesProblem(timeline, new Map([...files, ['s0.webp', webp(640, 400)]]))).toMatch(/size/u);
    expect(reelFilesProblem(timeline, new Map([...files, ['x.webp', webp(1280, 800)]]))).toMatch(/exactly/u);
  });

  it('refuses a timeline with markup in its words, or a tap after its step', () => {
    const step = { still: 's0.webp', width: 1280, height: 800, seconds: 2 };
    expect(reelTimelineSchema.safeParse({ version: 1, steps: [{ ...step, caption: '<b>hi</b>' }] }).success).toBe(
      false,
    );
    expect(
      reelTimelineSchema.safeParse({ version: 1, steps: [{ ...step, tap: { x: 0.1, y: 0.1, at: 3 } }] }).success,
    ).toBe(false);
    expect(reelTimelineSchema.safeParse({ version: 1, steps: [{ ...step, script: 'x' }] }).success).toBe(false);
  });
});
