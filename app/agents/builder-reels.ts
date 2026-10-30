import { z } from 'zod';
import { base64ToBytes, bytesToBase64 } from '~/lib/hex-digest';
import {
  REEL_DEFAULT_VOICE,
  REEL_TTS_MODEL,
  REEL_LIMITS,
  reelScriptSchema,
  reelTimelineSchema,
  type ReelBundle,
  type ReelScript,
  type ReelTimeline,
  type ReelVoice,
} from '~/lib/reel';
import { mp3Seconds, reelFilesProblem, stillInfo } from '~/lib/reel-files';

/**
 * A clip for the project's post, as the builder agent makes it and the chat holds it until the person decides
 * (app/lib/reel.ts). The agent takes real screenshots of the live site in the workspace and writes a script; the
 * `cloudchef reel` command hands both to the runtime (`showcase.internal`, reel-proxy.ts), and the conversation agent
 * makes the timeline here: each picture checked and renamed, each line spoken by Workers AI in the person's own
 * account. The clip then plays in the chat with Approve and Not now, and goes to CloudChef only if they approve.
 */

/** What the person sees of a clip in the chat. */
export type ReelDraftPublicState = {
  reelId: string;
  toolCallId: string;
  /** `waiting` for the person, `posting` once approved, `posted` on the post, `declined` with Not now. */
  status: 'waiting' | 'posting' | 'posted' | 'declined';
  /** The post it is for, `/<owner>/<slug>`. */
  postPath: string;
  seconds: number;
  /** Why posting failed, in words for the person, while it waits again; or that it waits for a review. */
  note: string | null;
  createdAt: number;
};

/** A clip in the chat, with what the player needs: its timeline and its files, base64-encoded. */
export type ReelDraftForChat = ReelBundle;

/** What the container's `cloudchef reel` sends: the agent's script and its picture files, base64-encoded. */
export const reelRequestSchema = z.strictObject({
  script: z.unknown(),
  files: z.record(z.string().max(80), z.string().max(Math.ceil((REEL_LIMITS.stillBytes * 4) / 3) + 4)).optional(),
});
export type ReelRequest = z.infer<typeof reelRequestSchema>;

/** A clip the runtime couldn't make, in words for the agent. */
export class ReelRefusal extends Error {
  override name = 'ReelRefusal';
}

/** Speaks a line in the person's account: an MP3. */
export type SpeakLine = (text: string, voice: ReelVoice) => Promise<Uint8Array>;

/** A spoken line is given this long after it ends before the next picture. */
const AFTER_LINE_SECONDS = 0.4;

/**
 * The timeline and files of a clip from the agent's script and pictures: every picture a still of the size it is,
 * renamed `s<n>`; every line spoken, `a<n>.mpeg`, its step lengthened to fit it.
 */
export async function makeReel(request: ReelRequest, speak: SpeakLine): Promise<ReelBundle> {
  const parsed = reelScriptSchema.safeParse(request.script);
  if (!parsed.success) {
    throw new ReelRefusal(`reel.json doesn’t fit the clip format: ${z.prettifyError(parsed.error)}`);
  }
  const script: ReelScript = parsed.data;
  const given = request.files ?? {};
  const files = new Map<string, Uint8Array>();
  const stills = new Map<string, { ref: string; width: number; height: number }>();
  for (const step of script.steps) {
    if (stills.has(step.still)) {
      continue;
    }
    const encoded = given[step.still];
    if (encoded === undefined) {
      throw new ReelRefusal(`${step.still} is named in reel.json but isn’t beside it.`);
    }
    const bytes = decode(encoded, step.still);
    const info = stillInfo(bytes);
    if (!info) {
      throw new ReelRefusal(`${step.still} isn’t a still WebP, PNG or JPEG picture.`);
    }
    if (bytes.byteLength > REEL_LIMITS.stillBytes) {
      throw new ReelRefusal(
        `${step.still} is ${Math.round(bytes.byteLength / 1024)} KB; save pictures as WebP of at most ${REEL_LIMITS.stillBytes / 1024} KB.`,
      );
    }
    const ref = `s${stills.size}.${info.contentType.slice('image/'.length)}`;
    stills.set(step.still, { ref, width: info.width, height: info.height });
    files.set(ref, bytes);
  }
  const voice = script.voice ?? REEL_DEFAULT_VOICE;
  const steps: ReelTimeline['steps'] = [];
  for (const [index, step] of script.steps.entries()) {
    const { still: _name, ...rest } = step;
    const still = stills.get(step.still)!;
    const made: ReelTimeline['steps'][number] = { ...rest, still: still.ref, width: still.width, height: still.height };
    if (step.say) {
      const audio = await speak(step.say, voice);
      const seconds = mp3Seconds(audio);
      if (seconds === null) {
        throw new ReelRefusal('Workers AI didn’t answer with speech for a line. Try again.');
      }
      if (seconds + AFTER_LINE_SECONDS > REEL_LIMITS.maxStepSeconds) {
        throw new ReelRefusal(`The line of step ${index + 1} takes ${seconds.toFixed(1)} seconds to say; shorten it.`);
      }
      const ref = `a${index}.mpeg`;
      files.set(ref, audio);
      made.audio = ref;
      made.seconds = Math.max(step.seconds, Math.round((seconds + AFTER_LINE_SECONDS) * 10) / 10);
    }
    steps.push(made);
  }
  const timeline = reelTimelineSchema.safeParse({ version: 1, steps });
  if (!timeline.success) {
    throw new ReelRefusal(`The clip doesn’t fit: ${z.prettifyError(timeline.error)}`);
  }
  const problem = reelFilesProblem(timeline.data, files);
  if (problem) {
    throw new ReelRefusal(problem);
  }
  return {
    timeline: timeline.data,
    files: Object.fromEntries([...files].map(([ref, bytes]) => [ref, bytesToBase64(bytes)])),
  };
}

function decode(encoded: string, name: string): Uint8Array {
  try {
    return base64ToBytes(encoded);
  } catch {
    throw new ReelRefusal(`${name} couldn’t be read.`);
  }
}

/** Speaks with `@cf/deepgram/aura-2-en` through the runtime's own Workers AI binding, in the person's account. */
export function workersAiSpeaker(ai: Ai): SpeakLine {
  return async (text, voice) => {
    const response = await ai.run(
      REEL_TTS_MODEL,
      { text, speaker: voice, encoding: 'mp3', bit_rate: 48_000 },
      { returnRawResponse: true },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReelRefusal(`Workers AI couldn’t speak a line (${response.status}). Try again, or leave out "say".`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

type ReelRow = {
  reel_id: string;
  tool_call_id: string;
  status: ReelDraftPublicState['status'];
  post_path: string;
  timeline_json: string;
  note: string | null;
  created_at: number;
};

/** The conversation's clips, in the agent's own SQLite (conversation-agent-schema.ts). */
export class BuilderReelRepository {
  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) {}

  add(args: { toolCallId: string; postPath: string; reel: ReelBundle; now?: number }): ReelDraftPublicState {
    const reelId = crypto.randomUUID();
    const now = args.now ?? Date.now();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO builder_reels (reel_id, tool_call_id, status, post_path, timeline_json, note, created_at)
         VALUES (?, ?, 'waiting', ?, ?, NULL, ?)`,
        reelId,
        args.toolCallId,
        args.postPath,
        JSON.stringify(args.reel.timeline),
        now,
      );
      for (const [ref, encoded] of Object.entries(args.reel.files)) {
        this.storage.sql.exec(
          'INSERT INTO builder_reel_files (reel_id, ref, bytes) VALUES (?, ?, ?)',
          reelId,
          ref,
          base64ToBytes(encoded).buffer,
        );
      }
    });
    return this.require(reelId);
  }

  private row(reelId: string): ReelRow | null {
    return (
      [
        ...this.storage.sql.exec<ReelRow>(
          `SELECT reel_id, tool_call_id, status, post_path, timeline_json, note, created_at
           FROM builder_reels WHERE reel_id = ?`,
          reelId,
        ),
      ][0] ?? null
    );
  }

  require(reelId: string): ReelDraftPublicState {
    const row = this.row(reelId);
    if (!row) {
      throw new ReelRefusal('This clip is no longer in the chat.');
    }
    return publicReel(row);
  }

  /** The clip with its files, for the chat's player and for posting; null once it was posted or put aside. */
  bundle(reelId: string): ReelBundle | null {
    const row = this.row(reelId);
    if (!row || (row.status !== 'waiting' && row.status !== 'posting')) {
      return null;
    }
    const files = [
      ...this.storage.sql.exec<{ ref: string; bytes: ArrayBuffer }>(
        'SELECT ref, bytes FROM builder_reel_files WHERE reel_id = ?',
        reelId,
      ),
    ];
    // SAFETY: timeline_json is what `add` stored, a timeline reelTimelineSchema had parsed.
    const timeline = JSON.parse(row.timeline_json) as ReelTimeline;
    return {
      timeline,
      files: Object.fromEntries(files.map(({ ref, bytes }) => [ref, bytesToBase64(new Uint8Array(bytes))])),
    };
  }

  /** Moves a clip on from `from`; false when it wasn't there (decided meanwhile). */
  move(reelId: string, from: ReelDraftPublicState['status'], to: ReelDraftPublicState['status'], note: string | null) {
    const moved = this.storage.sql.exec(
      'UPDATE builder_reels SET status = ?, note = ? WHERE reel_id = ? AND status = ?',
      to,
      note,
      reelId,
      from,
    ).rowsWritten;
    if (moved > 0 && (to === 'posted' || to === 'declined')) {
      // Once it is on the post, or put aside, its files are no longer needed here.
      this.storage.sql.exec('DELETE FROM builder_reel_files WHERE reel_id = ?', reelId);
    }
    return moved > 0;
  }

  listRecent(): ReelDraftPublicState[] {
    return [
      ...this.storage.sql.exec<ReelRow>(
        `SELECT reel_id, tool_call_id, status, post_path, timeline_json, note, created_at
         FROM builder_reels ORDER BY created_at DESC LIMIT 10`,
      ),
    ].map(publicReel);
  }
}

function publicReel(row: ReelRow): ReelDraftPublicState {
  // SAFETY: timeline_json is what `add` stored, a timeline reelTimelineSchema had parsed.
  const timeline = JSON.parse(row.timeline_json) as ReelTimeline;
  return {
    reelId: row.reel_id,
    toolCallId: row.tool_call_id,
    status: row.status,
    postPath: row.post_path,
    seconds: timeline.steps.reduce((total, step) => total + step.seconds, 0),
    note: row.note,
    createdAt: row.created_at,
  };
}
