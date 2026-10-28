import { afterEach, describe, expect, it, vi } from 'vitest';
import { appGitRefusal } from './app-git-access';

const identity = { userId: 'sara', accountId: 'account', connectionId: 'team-connection', connectionGeneration: 1 };
const access = { organizationAdmin: false, aiGatewayContentLogging: false };

function env(sharedAccount: '0' | '1') {
  return {
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://control-plane.test',
    CONTROL_PLANE_SECRET: 'runtime-secret',
    CLOUDCHEF_SHARED_ACCOUNT: sharedAccount,
  };
}

/** The control plane, saying which team project (if any) took an app's repository over. */
function adoption(orgProjectId: string | null) {
  const asked: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/runtime-projects/adoption')) {
      asked.push(JSON.parse(String(init?.body)));
      return Response.json({ orgProjectId });
    }
    return new Response('unavailable', { status: 503 });
  });
  return asked;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('git on a person’s own app', () => {
  it('is theirs while they may use their workspace', async () => {
    const asked = adoption(null);
    expect(await appGitRefusal(env('1'), identity, 'p-recipes', async () => access)).toBeNull();
    expect(asked).toEqual([{ repo: 'p-recipes' }]);
  });

  it('is refused once a team adopted the app as one of its projects: pushes, fetches and clones alike', async () => {
    adoption('team-project');
    expect(await appGitRefusal(env('1'), identity, 'p-recipes', async () => access)).toBe(
      'This app is now one of your team’s projects. Open it from Team projects to keep working on it.',
    );
  });

  it('is refused once they may no longer use their workspace, and never asks about teams in a person’s own account', async () => {
    const asked = adoption('team-project');
    expect(await appGitRefusal(env('1'), identity, 'p-recipes', async () => null)).toBe(
      'You no longer have access to this workspace.',
    );
    expect(await appGitRefusal(env('0'), identity, 'p-recipes', async () => access)).toBeNull();
    expect(asked).toEqual([]);
  });
});
