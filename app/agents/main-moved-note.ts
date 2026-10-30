import type { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';

/** How far back main's history is read for the commits git in the workspace hasn't fetched. */
const MAIN_LOG_LIMIT = 20;
/** How many of those commits are named one by one. */
const NAMED_COMMITS = 5;

type MainCommit = { hash: string; message: string; author: { name: string } };

/**
 * For the turn's context: the commits main took since git in the workspace last fetched or pushed it (`known`),
 * and who made them, so the model pulls before working rather than only once a push is turned away. Null when
 * main is still there (or nothing is known); main's first-parent history is read once, never a pack.
 */
export async function mainMovedNote(
  repositories: Pick<ProjectRepositories, 'log'>,
  repo: string,
  known: string | null,
): Promise<string | null> {
  if (!known) {
    return null;
  }
  const log = await repositories.log(repo, { limit: MAIN_LOG_LIMIT });
  return describeMainMoved(log, known);
}

/** What `mainMovedNote` says of main's newest commits (`log`, newest first), given the commit git last knew. */
export function describeMainMoved(log: readonly MainCommit[], known: string): string | null {
  if (log.length === 0 || log[0]?.hash === known) {
    return null;
  }
  const end = log.findIndex((commit) => commit.hash === known);
  const added = end === -1 ? log : log.slice(0, end);
  const count =
    end === -1 ? `more than ${added.length} commits` : `${added.length} commit${added.length === 1 ? '' : 's'}`;
  const authors = [...new Set(added.map((commit) => commit.author.name.trim()).filter(Boolean))];
  const lines = added
    .slice(0, NAMED_COMMITS)
    .map((commit) => `- ${commit.message.split('\n', 1)[0]?.trim().slice(0, 120)} (${commit.author.name.trim()})`);
  return [
    `main moved since git in the workspace last fetched it: ${count} newer than origin/main there${
      authors.length > 0 ? `, by ${authors.join(', ')}` : ''
    }.`,
    ...lines,
    ...(added.length > NAMED_COMMITS ? [`- and ${end === -1 ? 'more' : `${added.length - NAMED_COMMITS} more`}`] : []),
  ].join('\n');
}
