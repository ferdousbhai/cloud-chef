// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPerson } from '~/lib/cloudflare/org-projects.client';
import { ProjectPeople } from './ProjectPeople';

const person = (name: string, role: ProjectPerson['role'] = 'edit'): ProjectPerson => ({
  userId: name.toLowerCase(),
  name,
  image: null,
  role,
});

let root: Root | null = null;

async function render(people: ProjectPerson[], onManage?: () => void) {
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root?.render(<ProjectPeople project="Recipe Box" people={people} onManage={onManage} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

describe('the faces on a project’s card', () => {
  it('shows none for a project only its owner is on', async () => {
    const card = await render([person('Ada', 'owner')]);
    expect(card.textContent).toBe('');
    expect(card.querySelector('[role="img"], button')).toBeNull();
  });

  it('names everyone on it and what they may do, the owner first, and counts those past the fourth', async () => {
    const card = await render([
      person('Ada', 'owner'),
      person('Bo'),
      person('Cy', 'view'),
      person('Dee'),
      person('Eli'),
      person('Fay'),
    ]);
    const faces = card.querySelector('[role="img"]');
    expect(faces?.getAttribute('aria-label')).toBe(
      'On Recipe Box: Ada (owner), Bo (can edit), Cy (can view), Dee (can edit), Eli (can edit), Fay (can edit)',
    );
    expect(Array.from(card.querySelectorAll('[title]'), (face) => face.getAttribute('title'))).toEqual([
      'Ada · owner',
      'Bo · can edit',
      'Cy · can view',
      'Dee · can edit',
      'Eli, Fay',
    ]);
    expect(card.textContent).toContain('+2');
  });

  it('opens the project’s sharing for whoever runs it', async () => {
    const manage = vi.fn();
    const card = await render([person('Ada', 'owner'), person('Bo')], manage);
    const faces = card.querySelector('button');
    expect(faces?.getAttribute('aria-label')).toContain('Change who it is shared with');
    await act(async () => faces?.click());
    expect(manage).toHaveBeenCalledOnce();
  });
});
