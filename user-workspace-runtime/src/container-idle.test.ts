import { describe, expect, it } from 'vitest';
import {
  idleContainerCheck,
  unreportedContainerTime,
  WORKSPACE_CONTAINER_IDLE_TIMEOUT_MS,
  WORKSPACE_CONTAINER_KEEP_ALIVE_TIMEOUT_MS,
} from './computer-sandbox';

const NOW = 1_800_000_000_000;

describe('idleContainerCheck', () => {
  it('stops a container nothing has used for the idle window', () => {
    expect(
      idleContainerCheck({ now: NOW, lastUse: NOW - WORKSPACE_CONTAINER_IDLE_TIMEOUT_MS, keepAlive: false }),
    ).toEqual({ stop: true, idleMs: WORKSPACE_CONTAINER_IDLE_TIMEOUT_MS });
  });

  it('looks again when the window could have passed, counted from the last use', () => {
    expect(idleContainerCheck({ now: NOW, lastUse: NOW - 2 * 60_000, keepAlive: false })).toEqual({
      stop: false,
      checkInMs: WORKSPACE_CONTAINER_IDLE_TIMEOUT_MS - 2 * 60_000,
    });
  });

  it('keeps a container an operation holds past the idle window, and no longer than the keep-alive window', () => {
    expect(idleContainerCheck({ now: NOW, lastUse: NOW - 30 * 60_000, keepAlive: true })).toEqual({
      stop: false,
      checkInMs: WORKSPACE_CONTAINER_KEEP_ALIVE_TIMEOUT_MS - 30 * 60_000,
    });
    expect(
      idleContainerCheck({ now: NOW, lastUse: NOW - WORKSPACE_CONTAINER_KEEP_ALIVE_TIMEOUT_MS, keepAlive: true }).stop,
    ).toBe(true);
  });

  it('treats a last use in the future as just now', () => {
    expect(idleContainerCheck({ now: NOW, lastUse: NOW + 5_000, keepAlive: false })).toEqual({
      stop: false,
      checkInMs: WORKSPACE_CONTAINER_IDLE_TIMEOUT_MS,
    });
  });
});

describe('unreportedContainerTime', () => {
  it('counts whole seconds from the launch, then from where the last count ended, leaving the rest for the next', () => {
    expect(unreportedContainerTime({ launchedAt: NOW - 90_500, reportedUntil: null, now: NOW })).toEqual({
      seconds: 90,
      reportedUntil: NOW - 500,
    });
    expect(unreportedContainerTime({ launchedAt: NOW - 600_000, reportedUntil: NOW - 500, now: NOW + 700 })).toEqual({
      seconds: 1,
      reportedUntil: NOW + 500,
    });
  });

  it('has nothing to count within a second of the last count', () => {
    expect(unreportedContainerTime({ launchedAt: NOW - 400, reportedUntil: null, now: NOW })).toBeNull();
    expect(unreportedContainerTime({ launchedAt: NOW - 9_000, reportedUntil: NOW, now: NOW + 999 })).toBeNull();
  });

  it('carries no more than a day in one count, and still moves past all of it', () => {
    const launchedAt = NOW - 3 * 86_400_000;
    expect(unreportedContainerTime({ launchedAt, reportedUntil: null, now: NOW })).toEqual({
      seconds: 86_400,
      reportedUntil: NOW,
    });
  });
});
