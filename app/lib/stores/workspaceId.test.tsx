/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { chatUrlMask, maskedChatNavigation } from './workspaceId';

describe('chat URL lifecycle', () => {
  it('builds a reload-safe mask for the resumable chat URL', () => {
    expect(chatUrlMask('initial-chat-id')).toEqual({
      to: '/chat/$id',
      params: { id: 'initial-chat-id' },
      unmaskOnReload: true,
    });
  });

  it('publishes a masked chat URL while keeping the live homepage route active', async () => {
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' });
    const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chat/$id' });
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, chatRoute]), history });
    await router.load();

    await router.navigate(maskedChatNavigation('abc'));

    expect(history.location.pathname).toBe('/chat/abc');
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.matches.at(-1)?.routeId).toBe(indexRoute.id);
  });
});
