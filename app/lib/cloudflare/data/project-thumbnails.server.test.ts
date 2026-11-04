import { describe, expect, it } from 'vitest';
import { envWith, userWorkspaceDatabase } from '~/test/control-plane-d1';
import {
  forgetProjectThumbnail,
  thumbnailIsStale,
  userRuntimeProjectThumbnailAction,
} from './project-thumbnails.server';

const PROJECT = '7372c8cd-f192-479f-b136-4d188a9d0059';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function view(db: D1Database, project = PROJECT) {
  const work: Promise<unknown>[] = [];
  const url = new URL(`https://runtime.test/v1/projects/thumbnail?project=${project}`);
  return userRuntimeProjectThumbnailAction({
    url,
    env: envWith({ DB: db }),
    waitUntil: (promise) => work.push(promise),
  }).then((response) => ({ response, refreshes: work.length }));
}

describe('thumbnailIsStale', () => {
  const now = 100 * DAY;

  it('wants a first picture', () => {
    expect(thumbnailIsStale(null, undefined, now)).toBe(true);
  });

  it('keeps a recent picture of an unchanged project', () => {
    expect(thumbnailIsStale(now - DAY, undefined, now)).toBe(false);
  });

  it('wants a new picture after a week', () => {
    expect(thumbnailIsStale(now - 8 * DAY, undefined, now)).toBe(true);
  });

  it('wants a new picture when one predates the last change going live', () => {
    expect(thumbnailIsStale(now - 10 * MINUTE, now - 11 * MINUTE, now)).toBe(true);
  });

  it('keeps a picture taken once the last change had gone live', () => {
    expect(thumbnailIsStale(now - MINUTE, now - 10 * MINUTE, now)).toBe(false);
  });
});

describe('a project thumbnail', () => {
  it('is refused without a project', async () => {
    const { db } = userWorkspaceDatabase();
    const { response } = await view(db, 'not-a-project');
    expect(response.status).toBe(400);
  });

  it('is asked for once, however many views find none', async () => {
    const { db } = userWorkspaceDatabase();
    const first = await view(db);
    const second = await view(db);
    expect(first.response.status).toBe(404);
    expect(first.refreshes).toBe(1);
    expect(second.refreshes).toBe(0);
  });

  it('is served as a picture once there is one, without being taken again', async () => {
    const { db } = userWorkspaceDatabase();
    await db
      .prepare('INSERT INTO project_thumbnails (project_id, image, taken_at, requested_at) VALUES (?, ?, ?, ?)')
      .bind(PROJECT, new Uint8Array([1, 2, 3]), Date.now(), Date.now())
      .run();
    const { response, refreshes } = await view(db);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(refreshes).toBe(0);
  });

  it('goes with its project', async () => {
    const { db } = userWorkspaceDatabase();
    await view(db);
    await forgetProjectThumbnail(db, PROJECT);
    expect((await view(db)).refreshes).toBe(1);
  });
});
