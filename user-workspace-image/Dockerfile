# syntax=docker/dockerfile:1.7
#
# The container every user workspace (and its project builder) runs. Built and pushed by
# scripts/publish-user-workspace-image.mjs, which records the pushed manifest digest in
# user-workspace-image/workspace-image.lock.json; provisioning names exactly that digest in each runtime's
# container applications.
#
# computerd is the entrypoint: Computer's LegacyContainerBackend starts the container and dials it. The image
# carries everything a command needs so a cold container downloads nothing before it answers: Node at .nvmrc's
# version, pnpm and the credential-free cf CLI at the generated projects' pins, git, FUSE for computerd's mount,
# tmux for the person's terminal, and sandbox-shim, which @cloudflare/sandbox's file operations run. The
# runtime still writes its git wrapper, hooks and cf launcher at each start (container-toolchain.ts), so they
# change with the runtime, not the image.
#
# Every base is pinned by digest, and `node scripts/publish-user-workspace-image.mjs --check` keeps the ARG
# defaults in step with package.json, .nvmrc, the template, and cloudchef-agent/cloudflare-computer.ts: computerd
# speaks the protocol of the @cloudflare/computer release it is tagged with, and sandbox-shim that of the
# @cloudflare/sandbox release. Build for linux/amd64 only.

ARG NODE_IMAGE=docker.io/library/node:26.3.0-trixie-slim@sha256:95a34da32a840bd9b3b09a5b773591c16923e350174b1c50e1200c75bf15eaa9
ARG COMPUTERD_IMAGE=ghcr.io/cloudflare/computer-computerd-linux-x64:0.8.0@sha256:de6f3727a12c8adb2f8ece853105ccc461fef02f90e368fac4e0578eacc461aa
ARG SANDBOX_SHIM_IMAGE=docker.io/cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec

FROM ${COMPUTERD_IMAGE} AS computerd
FROM ${SANDBOX_SHIM_IMAGE} AS sandbox-shim

FROM ${NODE_IMAGE}
ARG PNPM_VERSION=11.14.0
ARG CF_CLI_VERSION=1.0.0-beta.24

LABEL org.opencontainers.image.title="CloudChef user workspace"
LABEL org.opencontainers.image.source="https://github.com/ferdousbhai/cloud-chef"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# fuse3 gives computerd a real FUSE mount. coreutils' `timeout`, findutils' `find -printf`, procps' `pkill`,
# util-linux's `flock` and `setpriv`, and passwd's `useradd` are what the runtime's and the builder's own
# commands rely on.
RUN set -eu; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates coreutils curl findutils fuse3 git jq passwd procps tar tmux unzip util-linux xz-utils zip; \
    rm -rf /var/lib/apt/lists/*; \
    sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf; \
    ln -sf /proc/mounts /etc/mtab

RUN npm install --global "pnpm@${PNPM_VERSION}" --ignore-scripts --no-audit --no-fund \
      --registry=https://registry.npmjs.org/ \
 && test "$(pnpm --version)" = "${PNPM_VERSION}" \
 && rm -rf /root/.npm

# Where the runtime's cf launcher looks for the pinned CLI before a project installs its own. No install script
# runs, and the optional local simulator is left out.
RUN mkdir -p "/opt/cloudchef/cf/${CF_CLI_VERSION}" \
 && npm install --prefix "/opt/cloudchef/cf/${CF_CLI_VERSION}" --no-save --ignore-scripts --omit=optional \
      --no-audit --no-fund --registry=https://registry.npmjs.org/ "cf@${CF_CLI_VERSION}" \
 && test -x "/opt/cloudchef/cf/${CF_CLI_VERSION}/node_modules/.bin/cf" \
 && rm -rf /root/.npm

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY --from=sandbox-shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY tmux.conf /etc/tmux.conf

# /home stays empty in the image: it is computerd's mount point, and the runtime takes an existing /home/project
# as proof the durable project is mounted there.
RUN mkdir -p /opt/cloudchef/pnpm-store

# computerd listens where the runtime's container backend dials (8080) and mounts the durable VFS at /home. The
# runtime passes the same values at launch; these make the image correct on its own.
ENV PORT=8080 MOUNT_POINT=/home FUSE_MOUNT=auto EXEC_SHELL=/bin/bash
EXPOSE 8080
WORKDIR /home
ENTRYPOINT ["/usr/local/bin/computerd"]
