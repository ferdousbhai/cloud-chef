import { z } from 'zod';

/**
 * A post's clip: "stills with motion". Real screenshots of the live site, taken by the builder agent in the person's
 * workspace, shown one after another with a slow pan or zoom, a caption, a tap mark and an optional spoken line. It is
 * data, never a video file or code: a timeline (below) and the pictures and sound clips it names, played by CloudChef's
 * own player (`app/components/showcase/ReelPlayer.tsx`), so nothing of the project runs where it is shown.
 *
 * Three shapes, one vocabulary:
 * - the script the agent writes (`reel.json`, `reelScriptSchema`), naming its own picture files and the lines to say;
 * - the timeline (`reelTimelineSchema`), made from the script by the workspace runtime, which renames every file to a
 *   reference (`s0.webp`, `a0.mpeg`), records each picture's size and speaks each line in the person's own account;
 * - the stored timeline, the same with each reference a media id, checked again by the control plane before it keeps it.
 */

export const REEL_LIMITS = {
  steps: 12,
  minStepSeconds: 0.8,
  maxStepSeconds: 8,
  totalSeconds: 45,
  captionChars: 120,
  sayChars: 240,
  stillBytes: 512 * 1024,
  audioBytes: 256 * 1024,
  totalBytes: 4 * 1024 * 1024,
  /** A picture's sides, in pixels: a phone's screen to a large desktop's. */
  minSide: 240,
  maxSide: 3200,
} as const;

/** Workers AI's English voices (`@cf/deepgram/aura-2-en`) a clip may speak in. */
const REEL_VOICES = [
  'athena',
  'apollo',
  'asteria',
  'aurora',
  'cora',
  'helena',
  'hermes',
  'luna',
  'orion',
  'thalia',
  'zeus',
] as const;
export type ReelVoice = (typeof REEL_VOICES)[number];
export const REEL_DEFAULT_VOICE: ReelVoice = 'athena';
export const REEL_TTS_MODEL = '@cf/deepgram/aura-2-en' as const;

/** Words shown or spoken: one line of plain text, nothing that could pass for markup or control characters. */
const plainLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}<>]*$/u, 'Use plain words, on one line.');

const fraction = z.number().min(0).max(1);
/** Where the frame looks: the point at its centre, as fractions of the picture, and how far it is zoomed in. */
const framingSchema = z.strictObject({ x: fraction, y: fraction, zoom: z.number().min(1).max(3) });
export type ReelFraming = z.infer<typeof framingSchema>;

const stepCommon = {
  seconds: z.number().min(REEL_LIMITS.minStepSeconds).max(REEL_LIMITS.maxStepSeconds),
  /** A slow move from one framing to another over the step; none shows the whole picture still. */
  pan: z.strictObject({ from: framingSchema, to: framingSchema }).optional(),
  /** A tap mark where something was pressed, `at` seconds into the step. */
  tap: z.strictObject({ x: fraction, y: fraction, at: z.number().min(0).max(REEL_LIMITS.maxStepSeconds) }).optional(),
  caption: plainLine(REEL_LIMITS.captionChars).optional(),
  /** The line spoken over the step. */
  say: plainLine(REEL_LIMITS.sayChars).optional(),
};

/** A picture file the agent saved beside its script. */
const scriptFileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(?:webp|png|jpe?g)$/u);

/** The agent's `reel.json`. */
export const reelScriptSchema = z.strictObject({
  voice: z.enum(REEL_VOICES).optional(),
  steps: z
    .array(z.strictObject({ still: scriptFileName, ...stepCommon }))
    .min(1)
    .max(REEL_LIMITS.steps),
});
export type ReelScript = z.infer<typeof reelScriptSchema>;

/** A file of a timeline: a picture or a spoken line, by a name the timeline gives it. */
const reelRefSchema = z.string().regex(/^[a-z0-9-]{1,40}\.(?:webp|png|jpeg|mpeg)$/u);

export const reelTimelineSchema = z
  .strictObject({
    version: z.literal(1),
    steps: z
      .array(
        z.strictObject({
          ...stepCommon,
          still: reelRefSchema,
          width: z.number().int().min(REEL_LIMITS.minSide).max(REEL_LIMITS.maxSide),
          height: z.number().int().min(REEL_LIMITS.minSide).max(REEL_LIMITS.maxSide),
          audio: reelRefSchema.optional(),
        }),
      )
      .min(1)
      .max(REEL_LIMITS.steps),
  })
  .refine((timeline) => reelSeconds(timeline) <= REEL_LIMITS.totalSeconds, {
    message: `A clip runs at most ${REEL_LIMITS.totalSeconds} seconds.`,
  })
  .refine((timeline) => timeline.steps.every((step) => !step.tap || step.tap.at <= step.seconds), {
    message: 'A tap mark comes within its step.',
  });
export type ReelTimeline = z.infer<typeof reelTimelineSchema>;
export type ReelStep = ReelTimeline['steps'][number];

export function reelSeconds(timeline: { steps: readonly { seconds: number }[] }): number {
  return timeline.steps.reduce((total, step) => total + step.seconds, 0);
}

/** Every file a timeline names, each once. */
export function reelRefs(timeline: ReelTimeline): string[] {
  return [...new Set(timeline.steps.flatMap((step) => (step.audio ? [step.still, step.audio] : [step.still])))];
}

/** The content type of a reference, from its extension. */
export function reelRefContentType(ref: string): 'image/webp' | 'image/png' | 'image/jpeg' | 'audio/mpeg' {
  switch (ref.slice(ref.lastIndexOf('.') + 1)) {
    case 'mpeg':
      return 'audio/mpeg';
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    default:
      return 'image/webp';
  }
}

/** The timeline with each reference renamed. */
export function renameReelRefs(timeline: ReelTimeline, rename: (ref: string) => string): ReelTimeline {
  return {
    ...timeline,
    steps: timeline.steps.map((step) => {
      const renamed: ReelStep = { ...step, still: rename(step.still) };
      if (step.audio) {
        renamed.audio = rename(step.audio);
      }
      return renamed;
    }),
  };
}

/** A clip as a post carries it: its stored timeline's address, its first picture, and how long it runs. */
export type PostReel = {
  url: string;
  poster: { url: string; width: number; height: number };
  seconds: number;
};

/**
 * Where `cloudchef reel` in the workspace container sends the agent's script and pictures: the runtime's ReelProxy,
 * which hands them to the agent whose command is running.
 */
export const REEL_PROXY_HOST = 'showcase.internal';
/** The script and its pictures, base64-encoded, a third larger than their limit. */
export const REEL_REQUEST_MAX_BYTES = Math.ceil((REEL_LIMITS.totalBytes * 4) / 3) + 64 * 1024;

/** A clip on its way, as JSON carries it: its timeline and its files, base64-encoded, by reference. */
export const reelBundleSchema = z.strictObject({
  timeline: reelTimelineSchema,
  files: z.record(reelRefSchema, z.string().max(Math.ceil((REEL_LIMITS.stillBytes * 4) / 3) + 4)),
});
export type ReelBundle = z.infer<typeof reelBundleSchema>;
