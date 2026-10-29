import lock from '../../../../user-workspace-image/workspace-image.lock.json' with { type: 'json' };

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Whether a workspace image lock names a published image: a repository, a tag, and the manifest digest
 * `scripts/publish-user-workspace-image.mjs` recorded when it pushed that tag.
 */
function isPublishedWorkspaceImageLock(value: { repository: string; tag: string; digest: string }): boolean {
  return value.repository.length > 0 && IMAGE_TAG.test(value.tag) && SHA256_DIGEST.test(value.digest);
}

/**
 * CloudChef's own workspace image (`user-workspace-image/Dockerfile`: computerd as the entrypoint, sandbox-shim,
 * Node, pnpm, cf, git, tmux), as every runtime's container applications run it, pinned by digest. It is also the
 * image identity recorded for each runtime, so a new pin makes every runtime outdated, as a new runtime build does.
 */
export const USER_WORKSPACE_IMAGE = `${lock.repository}:${lock.tag || 'unpublished'}@${lock.digest || `sha256:${'0'.repeat(64)}`}`;

/** Whether this release pins a published workspace image. Without one, no runtime is prepared or upgraded. */
export function isUserWorkspaceImagePublished(): boolean {
  return isPublishedWorkspaceImageLock(lock);
}
