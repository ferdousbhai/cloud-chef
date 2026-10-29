/**
 * The image every workspace and project-builder container starts from: Cloudflare's managed Debian trixie image
 * (Node 24 on `node:24.20.0-trixie-slim`, pinned by Cloudflare). It is offered only to container applications with
 * the `durable_object` scheduling policy, where the Durable Object names it in `ctx.container.start()`; nothing is
 * pushed to any registry. A container's first start installs what CloudChef needs on top of it and keeps the result
 * as the runtime's base snapshot, which later starts restore (`user-workspace-runtime/src/base-container.ts`).
 */
export const WORKSPACE_MANAGED_IMAGE = 'cloudflare/debian-trixie';

/** The scheduling policy of each runtime's container applications, fixed when Cloudflare creates one. */
export const WORKSPACE_CONTAINER_SCHEDULING_POLICY = 'durable_object';

/**
 * The container identity recorded for each runtime (its `image_digest`), so a runtime whose applications are not
 * yet on this policy and image is outdated, as one running an earlier runtime build is. What the base setup
 * installs changes with the runtime build itself, which is already part of that comparison.
 */
export const USER_WORKSPACE_IMAGE = `${WORKSPACE_MANAGED_IMAGE} (${WORKSPACE_CONTAINER_SCHEDULING_POLICY})`;
