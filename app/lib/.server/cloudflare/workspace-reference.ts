/** What a deployment's workspace reference names: `workspace-runtime:<project>:<workspace revision>:<revision>`. */
export type WorkspaceReference = { projectId: string; workspaceRevision: number; revision: string };

/** The parts of a workspace reference, or null for one in another form. */
export function parseWorkspaceReference(reference: string): WorkspaceReference | null {
  const match = /^workspace-runtime:([^:]+):(\d+):([a-f0-9]{64})$/.exec(reference);
  return match
    ? { projectId: decodeURIComponent(match[1]!), workspaceRevision: Number(match[2]), revision: match[3]! }
    : null;
}

/** The workspace reference naming a project's revision. */
export function workspaceReference(args: WorkspaceReference): string {
  if (!/^[a-f0-9]{64}$/.test(args.revision) || !Number.isSafeInteger(args.workspaceRevision)) {
    throw new Error('The user-owned workspace deployment reference is invalid.');
  }
  return `workspace-runtime:${encodeURIComponent(args.projectId)}:${args.workspaceRevision}:${args.revision}`;
}
