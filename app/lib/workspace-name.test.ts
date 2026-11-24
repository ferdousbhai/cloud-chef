import { describe, expect, it } from 'vitest';
import { spaceNameFor, workspaceName } from './workspace-name';

const mine = { orgName: 'Sam’s space', solo: true };
const studio = { orgName: 'Studio', solo: false };

describe('what a space is called to the person building in it', () => {
  it('calls one they are alone in Personal, and one with other people in it by its name', () => {
    expect(workspaceName(mine, [mine, studio])).toBe('Personal');
    expect(workspaceName(studio, [mine, studio])).toBe('Studio');
    // Once someone has joined theirs, it goes by the name those people see.
    const shared = { ...mine, solo: false };
    expect(workspaceName(shared, [shared])).toBe('Sam’s space');
  });

  it('never calls two spaces Personal: alone in more than one, each goes by its name', () => {
    const paid = { orgName: 'Paid space', solo: true };
    expect(workspaceName(mine, [mine, paid])).toBe('Sam’s space');
    expect(workspaceName(paid, [mine, paid])).toBe('Paid space');
  });
});

describe('what a space made for one person is called until they rename it', () => {
  it('is theirs by their first name, or simply theirs when they have none', () => {
    expect(spaceNameFor('Sam Rivera')).toBe('Sam’s space');
    expect(spaceNameFor('  ')).toBe('My space');
  });
});
