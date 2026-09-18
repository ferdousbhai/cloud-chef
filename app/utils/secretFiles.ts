import { pathSegments } from './pathNames';

const LOCAL_CREDENTIAL_FILE_NAMES = [
  '.npmrc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pypirc',
  '.yarnrc',
  '.yarnrc.yml',
] as const;
const PROJECT_DEPENDENCY_HOOK_FILE_NAMES = ['.pnpmfile.cjs', '.pnpmfile.js'] as const;
const FORBIDDEN_LOCAL_FILE_NAMES = [...LOCAL_CREDENTIAL_FILE_NAMES, ...PROJECT_DEPENDENCY_HOOK_FILE_NAMES] as const;

const LOCAL_SECRET_FILE_NAMES = new Set([...FORBIDDEN_LOCAL_FILE_NAMES, '.git', '.env', '.envrc', '.dev.vars']);
const PROJECT_DEPENDENCY_HOOK_FILE_NAME_SET = new Set<string>(PROJECT_DEPENDENCY_HOOK_FILE_NAMES);

export function isLocalSecretFilePath(filePath: string) {
  return pathSegments(filePath).some(
    (segment) =>
      LOCAL_SECRET_FILE_NAMES.has(segment) || segment.startsWith('.env.') || segment.startsWith('.dev.vars.'),
  );
}

export function assertNotLocalSecretFilePath(filePath: string) {
  if (!isLocalSecretFilePath(filePath)) {
    return;
  }

  if (pathSegments(filePath).some((segment) => PROJECT_DEPENDENCY_HOOK_FILE_NAME_SET.has(segment))) {
    throw new Error(
      `Project dependency hook files are disabled for CloudChef projects: ${filePath}. Use the reviewed pnpm workspace policy instead.`,
    );
  }

  throw new Error(
    `Local secret files are disabled for CloudChef projects: ${filePath}. Use a per-Worker secret or, for an exported project, an account-level Cloudflare Secrets Store binding instead.`,
  );
}
