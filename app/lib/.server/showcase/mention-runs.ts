import type { CloudflareAuthSession } from '~/lib/.server/auth';

/** What the comment box is told after a comment that mentions `@cloudchef`. */
export type MentionAnswer =
  { status: 'working' } | { status: 'no_space'; message: string } | { status: 'busy'; message: string };

/**
 * `@cloudchef` in a thread (docs/proposals/comment-threads.md): starts, or continues, the writer's chat for this
 * thread in their own space, full or read-only by their access to the project, and posts its final message as the
 * reply to `commentId` when the turn ends.
 */
export async function answerMention(
  _env: Env,
  _args: { session: CloudflareAuthSession; threadId: string; commentId: string },
): Promise<MentionAnswer | null> {
  return null;
}
