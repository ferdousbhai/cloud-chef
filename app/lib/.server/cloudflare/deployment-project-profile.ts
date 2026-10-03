export type DeploymentProjectType = 'web_app' | 'worker';

export type DeploymentProjectProfile = {
  type: DeploymentProjectType;
  bindings: {
    ai: boolean;
    d1: boolean;
    r2: boolean;
    kv: boolean;
    appAgent: boolean;
    /** Static assets behind a Worker-first `ASSETS` binding; absent on projects that predate it. */
    assets?: boolean;
  };
};

/** The capabilities a `cloudflare.project.json` declares, as the workspace runtime parsed it. */
type CloudflareProject = Partial<Record<'name' | 'entrypoint' | 'assets' | 'd1' | 'kv' | 'r2' | 'agent', unknown>>;

/**
 * Map a validated `cloudflare.project.json` to the managed deployment capabilities.
 *
 * The workspace runtime validates the file with the template's own parser first. CloudChef
 * provisions every resource itself and rebuilds the deployed configuration from trusted inputs, so
 * only which capabilities the project declares is read here.
 */
export function deploymentProjectProfileFromProject(
  project: CloudflareProject,
  type: DeploymentProjectType,
): DeploymentProjectProfile {
  const appAgent = project.agent !== undefined;
  const expectedEntrypoint = type === 'worker' || appAgent ? 'src/server.ts' : 'src/plain-server.ts';
  if (project.entrypoint !== expectedEntrypoint) {
    throw new Error(`The generated Worker entrypoint must be ${expectedEntrypoint} for this project profile.`);
  }
  const assets = project.assets === true;
  if (assets && type !== 'web_app') {
    throw new Error('Only a web app may declare static assets.');
  }
  return {
    type,
    bindings: {
      ai: appAgent,
      d1: project.d1 !== undefined,
      r2: project.r2 !== undefined,
      kv: project.kv !== undefined,
      appAgent,
      assets,
    },
  };
}
