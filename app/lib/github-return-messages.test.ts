import { describe, expect, it } from 'vitest';
import { gitHubReturnMessageText } from './github-return-messages';

describe('gitHubReturnMessageText', () => {
  it('shows only the fixed text of a known code, never words the link brought', () => {
    expect(gitHubReturnMessageText('connected')).toBe('Connected GitHub.');
    expect(gitHubReturnMessageText('Your account is locked. Call +1 555 0100 to restore it.')).toBeNull();
    expect(gitHubReturnMessageText('toString')).toBeNull();
    expect(gitHubReturnMessageText('')).toBeNull();
  });
});
