import { describe, expect, it } from 'vitest';
import { localD1MigrationArgs, remoteD1MigrationArgs } from './apply-d1-migrations.mjs';
import { PLACEHOLDER_D1_ID } from './lib/cloudflare-config.mjs';

const databaseId = '04680db0-07a0-468d-9547-e07f5091756c';
const bound = (id: string) => ({ d1_databases: [{ binding: 'DB', database_id: id }] });

describe('control-plane D1 migrations', () => {
  it('applies them with cf, to the database cloudflare.config.ts binds', () => {
    expect(remoteD1MigrationArgs(bound(databaseId))).toEqual([
      'exec',
      'cf',
      'd1',
      'migrations',
      'apply',
      databaseId,
      '--dir',
      'migrations',
    ]);
    expect(localD1MigrationArgs(bound(databaseId))).toEqual([
      'exec',
      'cf',
      'd1',
      'migrations',
      'apply',
      databaseId,
      '--dir',
      'migrations',
      '--local',
    ]);
  });

  it('migrates a fork’s local database before its real one is provisioned, and never a remote placeholder', () => {
    expect(localD1MigrationArgs(bound(PLACEHOLDER_D1_ID))).toContain(PLACEHOLDER_D1_ID);
    expect(() => remoteD1MigrationArgs(bound(PLACEHOLDER_D1_ID))).toThrow('provisioned D1 database id');
  });
});
