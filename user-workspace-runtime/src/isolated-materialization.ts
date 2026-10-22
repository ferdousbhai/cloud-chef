/**
 * Plan how a project is written into an isolated build root.
 *
 * The root is materialized from the durable VFS, the same source every guard around a build reads,
 * never copied out of the container's mounted `/home/project`, which can diverge from it after a
 * container recycle (#139). The cost is a read and a write per file, so they run concurrently.
 */

/**
 * Files in flight at once.
 *
 * Each holds one file's bytes, so the ceiling is this times the per-file limit (16 MiB) — the
 * same order as the whole-project read this replaces, which held every file at once under a 64 MiB
 * cap. Raising it trades isolate memory for wall clock, and the isolate has 128 MiB.
 */
export const MATERIALIZATION_CONCURRENCY = 4;

export function isolatedTargetPath(args: { isolatedRoot: string; projectRoot: string; path: string }): string {
  const relative = args.path.slice(args.projectRoot.length).replace(/^\/+/, '');
  if (!args.path.startsWith(`${args.projectRoot}/`) || relative.length === 0) {
    throw new Error(`Project file is outside its root: ${args.path}`);
  }
  return `${args.isolatedRoot}/${relative}`;
}

/** Every directory that must exist before the writes, parents first so each mkdir has a parent. */
export function requiredDirectories(targets: readonly string[], isolatedRoot: string): string[] {
  const directories = new Set<string>();
  for (const target of targets) {
    let directory = target.slice(0, target.lastIndexOf('/'));
    while (directory.length > isolatedRoot.length && !directories.has(directory)) {
      directories.add(directory);
      directory = directory.slice(0, directory.lastIndexOf('/'));
    }
  }
  return [...directories].sort((left, right) => left.length - right.length);
}

/** Run `worker` over every item, never more than `limit` at a time. */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(runners);
}
