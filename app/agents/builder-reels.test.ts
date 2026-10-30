import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '~/lib/hex-digest';
import { makeReel, ReelRefusal } from './builder-reels';

/** The first bytes of a lossy WebP of `width` by `height`, which is all the checks read. */
function webp(width: number, height: number): string {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  bytes.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [...'WEBPVP8 '].map((c) => c.charCodeAt(0)),
    8,
  );
  bytes.set([0x9d, 0x01, 0x2a], 23);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytesToBase64(bytes);
}

/** `frames` MPEG-2 layer III frames at 48 kbit/s, 24 kHz: 24 ms each. */
function mp3(frames: number): Uint8Array {
  const bytes = new Uint8Array(frames * 144);
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.set([0xff, 0xf3, 0x64, 0x00], frame * 144);
  }
  return bytes;
}

describe('making a clip', () => {
  it('renames each picture, speaks each line and lengthens its step to fit', async () => {
    const spoken: string[] = [];
    const reel = await makeReel(
      {
        script: {
          voice: 'luna',
          steps: [
            { still: 'home.webp', seconds: 2, caption: 'Your recipes', say: 'Here are your recipes.' },
            { still: 'add.webp', seconds: 2.5, tap: { x: 0.8, y: 0.1, at: 0.6 } },
            { still: 'home.webp', seconds: 1.5 },
          ],
        },
        files: { 'home.webp': webp(1280, 800), 'add.webp': webp(1280, 800), 'unused.webp': webp(1280, 800) },
      },
      async (text, voice) => {
        spoken.push(`${voice}: ${text}`);
        return mp3(125); // 3 seconds
      },
    );
    expect(spoken).toEqual(['luna: Here are your recipes.']);
    expect(reel.timeline.steps.map((step) => [step.still, step.seconds, step.audio])).toEqual([
      ['s0.webp', 3.4, 'a0.mpeg'],
      ['s1.webp', 2.5, undefined],
      ['s0.webp', 1.5, undefined],
    ]);
    expect(Object.keys(reel.files).sort()).toEqual(['a0.mpeg', 's0.webp', 's1.webp']);
  });

  it('says what is wrong in words the agent can act on', async () => {
    const speak = async () => mp3(10);
    await expect(makeReel({ script: { steps: [] }, files: {} }, speak)).rejects.toThrow(/reel\.json/u);
    await expect(
      makeReel({ script: { steps: [{ still: 'home.webp', seconds: 2 }] }, files: {} }, speak),
    ).rejects.toThrow(/isn’t beside it/u);
    await expect(
      makeReel(
        {
          script: { steps: [{ still: 'home.webp', seconds: 2 }] },
          files: { 'home.webp': bytesToBase64(new Uint8Array(80)) },
        },
        speak,
      ),
    ).rejects.toBeInstanceOf(ReelRefusal);
    await expect(
      makeReel(
        {
          script: { steps: [{ still: 'home.webp', seconds: 2, say: 'A very long line.' }] },
          files: { 'home.webp': webp(1280, 800) },
        },
        async () => mp3(400),
      ),
    ).rejects.toThrow(/shorten it/u);
  });
});
