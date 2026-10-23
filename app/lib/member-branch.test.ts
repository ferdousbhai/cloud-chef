import { describe, expect, it } from 'vitest';
import { memberBranch } from './member-branch';

describe('memberBranch', () => {
  it("names a member's branch after their email and id, then the workspace's key", () => {
    expect(memberBranch({ email: 'Sara.A@example.com', userId: 'B86c65xyz' }, 'k3y12345')).toBe(
      'cloudchef/sara-a-b86c65-k3y12345',
    );
    expect(memberBranch({ email: '+++@example.com', userId: 'a_b-c!' }, undefined)).toBe('cloudchef/member-a0b0c0');
  });
});
