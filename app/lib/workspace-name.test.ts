import { describe, expect, it } from 'vitest';
import { spaceNameFor, workspaceName } from './workspace-name';

describe('what an account is called to the person working in it', () => {
  it('calls their own Personal, whoever else is on its projects, and someone else’s by its name', () => {
    expect(workspaceName({ orgName: 'Sam’s account', personal: true })).toBe('Personal');
    expect(workspaceName({ orgName: 'Ada’s account', personal: false })).toBe('Ada’s account');
  });
});

describe('what a person’s own account is called to the people added to its projects', () => {
  it('is theirs by their first name, or simply theirs when they have none', () => {
    expect(spaceNameFor('Sam Rivera')).toBe('Sam’s account');
    expect(spaceNameFor('  ')).toBe('My account');
  });
});
