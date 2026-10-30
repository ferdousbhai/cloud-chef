import { describe, expect, it } from 'vitest';
import { describeMainMoved, mainMovedNote } from './main-moved-note';

function commit(hash: string, message: string, name: string) {
  return { hash: hash.repeat(40), message, author: { name } };
}

const known = commit('a', 'Start', 'Ada');

describe('what the model is told of main at the start of a turn', () => {
  it('names the commits main took since git last fetched it, newest first, and who made them', () => {
    const log = [
      commit('c', 'Fix the footer\n\nLonger text', 'Sara Ahmed'),
      commit('b', 'Add the pricing page', 'Sara Ahmed'),
      known,
    ];
    expect(describeMainMoved(log, known.hash)).toBe(
      'main moved since git in the workspace last fetched it: 2 commits newer than origin/main there, by Sara Ahmed.\n' +
        '- Fix the footer (Sara Ahmed)\n' +
        '- Add the pricing page (Sara Ahmed)',
    );
  });

  it('says nothing while main is where git last saw it', () => {
    expect(describeMainMoved([known], known.hash)).toBeNull();
    expect(describeMainMoved([], known.hash)).toBeNull();
  });

  it('says only that there are more when the commit git knew is further back than is read', () => {
    const log = Array.from({ length: 7 }, (_, index) =>
      commit(String(index), `Change ${index}`, index % 2 ? 'Ada' : 'Sara'),
    );
    const note = describeMainMoved(log, known.hash);
    expect(note).toContain('more than 7 commits newer than origin/main there, by Sara, Ada.');
    expect(note?.split('\n')).toHaveLength(7);
    expect(note).toContain('- and more');
  });

  it('reads nothing when git in the workspace has never seen main', async () => {
    let read = false;
    const repositories = {
      log: async () => {
        read = true;
        return [];
      },
    };
    expect(await mainMovedNote(repositories, 'p-site', null)).toBeNull();
    expect(read).toBe(false);
  });
});
