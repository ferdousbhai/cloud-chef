/**
 * CloudChef's workspace image (user-workspace-image/): check its pins, build and push it, and record what was
 * pushed. Only the owner runs the publish, from a machine with Docker and buildx, logged in to the registry
 * the lock names; nothing in CI or a deploy publishes.
 *
 *   node scripts/publish-user-workspace-image.mjs --check             the Dockerfile's pins match this checkout
 *   node scripts/publish-user-workspace-image.mjs                     build, push, and pin the digest in the lock
 *   node scripts/publish-user-workspace-image.mjs --repository R      the same, to another repository
 *   node scripts/publish-user-workspace-image.mjs --require-published the lock pins a pushed image (deploy gate)
 *
 * The image goes to a public registry the platform-scheduled container applications in every person's account
 * pull from (Docker Hub, like the Cloudflare Sandbox image before it). Pushing never changes a live runtime: a
 * runtime runs the new image only once a release committing its pin is deployed and the runtime is upgraded.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_DIR = join(ROOT, 'user-workspace-image');
const LOCK_PATH = join(IMAGE_DIR, 'workspace-image.lock.json');
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** The default of each `ARG NAME=value` in a Dockerfile. */
export function dockerfileArgs(dockerfile) {
  const args = {};
  for (const match of dockerfile.matchAll(/^ARG\s+([A-Z_]+)=(\S+)\s*$/gm)) {
    args[match[1]] = match[2];
  }
  return args;
}

/**
 * Every disagreement between the Dockerfile's pins and this checkout: computerd and sandbox-shim tagged with the
 * exact package versions they speak the protocol of, each base pinned by digest, Node at .nvmrc's version, and pnpm
 * and cf at the generated projects' pins. Empty when they agree.
 */
export function workspaceImagePinErrors({ dockerfile, packageJson, nvmrc, templatePackageJson, computerSource }) {
  const errors = [];
  const args = dockerfileArgs(dockerfile);
  const dependencies = JSON.parse(packageJson).dependencies ?? {};
  const template = JSON.parse(templatePackageJson);
  const pnpm = /GENERATED_PROJECT_PNPM_VERSION = '([^']+)'/.exec(computerSource)?.[1];
  const expectations = [
    ['NODE_IMAGE', `docker.io/library/node:${nvmrc.trim()}-trixie-slim`],
    ['COMPUTERD_IMAGE', `ghcr.io/cloudflare/computer-computerd-linux-x64:${dependencies['@cloudflare/computer']}`],
    ['SANDBOX_SHIM_IMAGE', `docker.io/cloudflare/sandbox:${dependencies['@cloudflare/sandbox']}`],
  ];
  for (const [name, reference] of expectations) {
    const value = args[name] ?? '';
    const [named, digest] = value.split('@');
    if (named !== reference) {
      errors.push(`${name} must be ${reference}, pinned by digest; it is ${value || 'missing'}.`);
    } else if (!SHA256_DIGEST.test(digest ?? '')) {
      errors.push(`${name} must be pinned by a sha256 digest.`);
    }
  }
  if (args.PNPM_VERSION !== pnpm) {
    errors.push(`PNPM_VERSION must be ${pnpm} (GENERATED_PROJECT_PNPM_VERSION); it is ${args.PNPM_VERSION}.`);
  }
  if (args.CF_CLI_VERSION !== template.devDependencies?.cf) {
    errors.push(
      `CF_CLI_VERSION must be ${template.devDependencies?.cf} (the template's cf); it is ${args.CF_CLI_VERSION}.`,
    );
  }
  if (!/^ENTRYPOINT \["\/usr\/local\/bin\/computerd"\]$/m.test(dockerfile)) {
    errors.push('The image must start computerd as its entrypoint.');
  }
  return errors;
}

/** Whether the lock names a pushed image: a repository, its tag, and the manifest digest the push returned. */
export function isPublishedLock(lock) {
  return (
    String(lock.repository ?? '').length > 0 && IMAGE_TAG.test(lock.tag ?? '') && SHA256_DIGEST.test(lock.digest ?? '')
  );
}

/**
 * The tag a build is pushed as: the two vendor versions it carries and a digest of the build context, so the
 * same context always gets the same tag, and a changed one never overwrites an earlier tag.
 */
export function workspaceImageTag({ packageJson, context }) {
  const dependencies = JSON.parse(packageJson).dependencies ?? {};
  const hash = createHash('sha256');
  for (const [name, content] of Object.entries(context).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${name}\0${content}\0`);
  }
  return `computer-${dependencies['@cloudflare/computer']}-sandbox-${dependencies['@cloudflare/sandbox']}-${hash
    .digest('hex')
    .slice(0, 12)}`;
}

function readSources() {
  return {
    dockerfile: readFileSync(join(IMAGE_DIR, 'Dockerfile'), 'utf8'),
    tmuxConf: readFileSync(join(IMAGE_DIR, 'tmux.conf'), 'utf8'),
    packageJson: readFileSync(join(ROOT, 'package.json'), 'utf8'),
    nvmrc: readFileSync(join(ROOT, '.nvmrc'), 'utf8'),
    templatePackageJson: readFileSync(join(ROOT, 'template/package.json'), 'utf8'),
    computerSource: readFileSync(join(ROOT, 'cloudchef-agent/cloudflare-computer.ts'), 'utf8'),
  };
}

function check(sources) {
  const errors = workspaceImagePinErrors(sources);
  if (errors.length > 0) {
    throw new Error(`The workspace image's pins do not match this checkout:\n- ${errors.join('\n- ')}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit status ${result.status}.`);
  }
}

function publish(sources, repository) {
  check(sources);
  const tag = workspaceImageTag({
    packageJson: sources.packageJson,
    context: { Dockerfile: sources.dockerfile, 'tmux.conf': sources.tmuxConf },
  });
  const metadataFile = join(mkdtempSync(join(tmpdir(), 'cloudchef-workspace-image-')), 'metadata.json');
  run('docker', [
    'buildx',
    'build',
    '--platform',
    'linux/amd64',
    '--provenance=false',
    '--sbom=false',
    '--push',
    '--metadata-file',
    metadataFile,
    '--tag',
    `${repository}:${tag}`,
    IMAGE_DIR,
  ]);
  const digest = JSON.parse(readFileSync(metadataFile, 'utf8'))['containerimage.digest'];
  if (!SHA256_DIGEST.test(digest ?? '')) {
    throw new Error('docker buildx did not report the pushed manifest digest.');
  }
  const lock = { repository, tag, digest };
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  process.stdout.write(
    `Pushed ${repository}:${tag}@${digest}\nPinned it in user-workspace-image/workspace-image.lock.json; commit that file to release it.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, value, ...rest] = process.argv.slice(2);
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  try {
    if (command === '--check' && value === undefined) {
      check(readSources());
      process.stdout.write('The workspace image pins match this checkout.\n');
    } else if (command === '--require-published' && value === undefined) {
      if (!isPublishedLock(lock)) {
        throw new Error(
          'This release pins no published workspace image (user-workspace-image/workspace-image.lock.json). ' +
            'Publish it with `pnpm run workspace-image:publish` and commit the lock before deploying.',
        );
      }
      check(readSources());
    } else if (command === undefined) {
      publish(readSources(), lock.repository);
    } else if (command === '--repository' && value && rest.length === 0) {
      publish(readSources(), value);
    } else {
      throw new Error(
        'Usage: node scripts/publish-user-workspace-image.mjs [--check | --require-published | --repository <repository>]',
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
