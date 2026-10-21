/**
 * Why CloudChef can't commit files at these paths to GitHub, or null when it can. GitHub's tree API
 * refuses a path that isn't plain (a leading or trailing slash, an empty, `.` or `..` part, or anything in
 * `.git`), and refuses to change a GitHub Actions workflow with a token lacking the `workflows` permission,
 * which CloudChef never asks for: a project's pipeline is Workers Builds. Checked when a commit is asked
 * for, so the refusal comes in words the agent can act on rather than as GitHub's error after the fact.
 */
export function commitPathRefusal(paths: Iterable<string>): string | null {
  for (const path of paths) {
    const parts = path.split('/');
    if (
      path.includes('\0') ||
      parts.some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')
    ) {
      return `GitHub doesn't accept “${path.slice(0, 200)}” as a file path. Rename or remove it and try again.`;
    }
    if (parts.length > 2 && parts[0]?.toLowerCase() === '.github' && parts[1]?.toLowerCase() === 'workflows') {
      return (
        `GitHub Actions workflow files (${path.slice(0, 200)}) can't be published through CloudChef. Remove the ` +
        'changes under .github/workflows/ and try again: Workers Builds deploys the project.'
      );
    }
  }
  return null;
}
