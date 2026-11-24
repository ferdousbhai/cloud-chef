import { describe, expect, it } from 'vitest';
import { workspaceName } from './workspace-name';

const own = { kind: 'personal' } as const;
const team = { kind: 'organization', orgName: 'Studio', solo: false } as const;
const aloneInSpace = { kind: 'organization', orgName: 'Sam’s space', solo: true } as const;

describe('what an account is called to the person building in it', () => {
  it('calls their own Cloudflare account Personal and a team by its name', () => {
    expect(workspaceName(own, [own, team])).toBe('Personal');
    expect(workspaceName(team, [own, team])).toBe('Studio');
  });

  it('calls a space CloudChef runs Personal while they are alone in it, and by its name once others are', () => {
    expect(workspaceName(aloneInSpace, [aloneInSpace, team])).toBe('Personal');
    const shared = { ...aloneInSpace, solo: false };
    expect(workspaceName(shared, [shared])).toBe('Sam’s space');
  });

  it('never calls two accounts Personal: a space beside a Cloudflare account of their own goes by its name', () => {
    expect(workspaceName(aloneInSpace, [own, aloneInSpace])).toBe('Sam’s space');
    expect(workspaceName(own, [own, aloneInSpace])).toBe('Personal');
  });
});
