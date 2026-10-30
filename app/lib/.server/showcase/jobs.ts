import { fileReport, recordPublication, replaceScreenshot } from '~/lib/cloudflare/data/posts.server';
import type { ProductionPublish } from '~/lib/cloudflare/data/org-projects.server';
import { classifyMedia, takeScreenshot } from './screenshot';
import { mediaKey } from './media';
import { scanVerdict, submitScan } from './url-scanner';

/**
 * Showcase work done in the background, on the `cloudchef-showcase` queue: a post's screenshot after a publish, and
 * the URL Scanner's verdict on its site.
 */
export type ShowcaseJob =
  | { kind: 'screenshot'; postId: string; commit: string; siteUrl: string }
  | { kind: 'scan_verdict'; postId: string; scanId: string; attempt: number };

/** How long the URL Scanner is given before its verdict is read, and how many times it is read. */
const SCAN_WAIT_SECONDS = 60;
const SCAN_READS = 5;

/** What posting a publish needs: the database, and the queue its screenshot is taken from. */
type PostingEnv = { DB: D1Database; SHOWCASE_JOBS: Pick<Queue, 'send'> };

function sendJob(env: PostingEnv, job: ShowcaseJob, delaySeconds?: number): Promise<void> {
  return env.SHOWCASE_JOBS.send(job, delaySeconds ? { delaySeconds } : undefined).then(() => undefined);
}

/**
 * A project's production publish, as `recordProductionPublish` answers it the first time a commit of main is recorded
 * live: a public project's post is made or updated (`recordPublication`), on the page of whoever pushed the commit
 * (else the project's author), and a new screenshot taken; private projects never post. Called with that function's
 * non-null answer, from both places it is recorded (CloudChef's builder reporting a deploy, and a Workers Builds
 * status read). Asking again about a commit the post already shows changes nothing. Never throws: the publish has
 * succeeded whatever happens to its post.
 */
export async function projectPublished(env: PostingEnv, publish: ProductionPublish): Promise<void> {
  try {
    const outcome = await recordPublication(env.DB, {
      projectId: publish.projectId,
      commit: publish.commit,
      by: publish.pushedBy,
      siteUrl: publish.siteUrl,
    });
    if (outcome.kind !== 'created' && outcome.kind !== 'updated') {
      return;
    }
    await sendJob(env, {
      kind: 'screenshot',
      postId: outcome.postId,
      commit: publish.commit,
      siteUrl: outcome.siteUrl,
    });
  } catch (error) {
    console.error('[Showcase] Unable to post a publish', error instanceof Error ? error.message : 'not an Error');
  }
}

/** The queue consumer: each job once, retried by the queue when it throws. */
export async function runShowcaseJobs(batch: MessageBatch<ShowcaseJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runJob(env, message.body);
      message.ack();
    } catch (error) {
      console.error(
        '[Showcase] A job failed',
        message.body.kind,
        error instanceof Error ? error.message : 'not an Error',
      );
      message.retry({ delaySeconds: 30 });
    }
  }
}

async function runJob(env: Env, job: ShowcaseJob): Promise<void> {
  if (job.kind === 'screenshot') {
    const shot = await takeScreenshot(env, job.siteUrl);
    if (shot) {
      const id = crypto.randomUUID();
      const key = mediaKey(job.postId, id, shot.contentType);
      await env.SHOWCASE_MEDIA.put(key, shot.bytes, { httpMetadata: { contentType: shot.contentType } });
      const kept = await replaceScreenshot(env.DB, {
        postId: job.postId,
        commit: job.commit,
        media: {
          id,
          kind: 'screenshot',
          origin: 'automatic',
          r2Key: key,
          contentType: shot.contentType,
          bytes: shot.bytes.byteLength,
          width: shot.width,
          height: shot.height,
          commit: job.commit,
          state: await classifyMedia(env, shot.bytes, shot.contentType),
        },
      });
      if (!kept) {
        // The post moved on to a newer commit, or went, while the picture was taken.
        await env.SHOWCASE_MEDIA.delete(key);
      }
    }
    const scanId = await submitScan(env, job.siteUrl).catch(() => null);
    if (scanId) {
      await sendJob(env, { kind: 'scan_verdict', postId: job.postId, scanId, attempt: 1 }, SCAN_WAIT_SECONDS);
    }
    return;
  }
  const verdict = await scanVerdict(env, job.scanId);
  if (verdict === null) {
    if (job.attempt < SCAN_READS) {
      await sendJob(env, { ...job, attempt: job.attempt + 1 }, SCAN_WAIT_SECONDS);
    }
    return;
  }
  if (verdict.malicious) {
    // A malicious verdict holds the post at once, for an operator to look at.
    await fileReport(env.DB, {
      postId: job.postId,
      commentId: null,
      reporterId: null,
      reporterIpHash: null,
      reason: 'scam_or_phishing',
      note: 'Cloudflare’s URL Scanner judged this site malicious.',
      automatic: true,
    }).catch(() => undefined);
  }
}
