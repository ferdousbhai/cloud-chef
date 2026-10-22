import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  findD1MigrationSafetyErrors,
  findUnsafeD1MigrationOperations,
  verifyD1MigrationSafety,
} from './verify-d1-migrations.mjs';

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function errorsFor(sql: string): string[] {
  const baseline = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
  return findD1MigrationSafetyErrors(
    [
      { name: '0001_initial.sql', content: baseline },
      { name: '0002_change.sql', content: sql },
    ],
    {
      directory: 'migrations',
      checksums: { '0001_initial.sql': digest(baseline), '0002_change.sql': digest(sql) },
    },
  );
}

describe('D1 migration rollout policy', () => {
  it('accepts the repository migration history', () => {
    expect(verifyD1MigrationSafety()).toEqual([]);
  });

  it('allows additive schema changes and bounded backfills', () => {
    expect(
      errorsFor(`
        ALTER TABLE example ADD COLUMN display_name TEXT;
        CREATE INDEX IF NOT EXISTS idx_example_display_name ON example(display_name);
        UPDATE example SET display_name = 'unknown' WHERE display_name IS NULL;
        DELETE FROM example WHERE id = 'retired';
        PRAGMA defer_foreign_keys = ON;
      `),
    ).toEqual([]);
  });

  it.each([
    ['DROP TABLE example;', 'DROP removes schema in place'],
    ['DROP INDEX idx_example;', 'DROP removes schema in place'],
    ['ALTER TABLE example RENAME TO former_example;', 'ALTER TABLE RENAME rewrites schema in place'],
    ['ALTER TABLE example DROP COLUMN display_name;', 'ALTER TABLE DROP removes schema in place'],
    ["INSERT OR REPLACE INTO example (id) VALUES ('id');", 'REPLACE can delete conflicting rows'],
    ["UPDATE example SET id = 'rewritten';", 'UPDATE without a top-level WHERE rewrites every row'],
    ['DELETE FROM example;', 'DELETE without a top-level WHERE removes every row'],
    ['PRAGMA foreign_keys = OFF;', 'PRAGMA foreign_keys = OFF bypasses referential integrity'],
    ['PRAGMA writable_schema = ON;', 'PRAGMA writable_schema bypasses schema safety'],
  ])('rejects unsafe new migration SQL: %s', (sql, reason) => {
    expect(errorsFor(sql)).toContain(
      `migrations/0002_change.sql is not expand/contract safe: ${reason}; stage the additive replacement before a separately reviewed exact-digest contract exception.`,
    );
  });

  it('does not treat comments, literals, identifiers, or nested predicates as destructive SQL', () => {
    expect(
      findUnsafeD1MigrationOperations(`
        -- DROP TABLE example;
        /* DELETE FROM example; */
        INSERT INTO example (id) VALUES ('DROP TABLE example;');
        UPDATE example SET id = (SELECT id FROM other WHERE other.id = example.id);
      `),
    ).toEqual(['UPDATE without a top-level WHERE rewrites every row']);
  });

  it('keeps every checksum-tracked migration immutable and rejects legacy history insertion', () => {
    const baseline = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
    expect(
      findD1MigrationSafetyErrors(
        [
          { name: '0001_initial.sql', content: `${baseline}\n` },
          { name: '0001_replacement.sql', content: baseline },
        ],
        {
          directory: 'migrations',
          checksums: { '0001_initial.sql': digest(baseline) },
        },
      ),
    ).toEqual([
      'migrations/0001_initial.sql is checksum-tracked D1 migration history and must remain immutable; add a new additive migration instead.',
      'migrations/0001_replacement.sql must have an exact SHA-256 checksum entry before it can ship.',
      'migrations/0001_replacement.sql cannot be inserted into legacy migration history at or before 0001.',
    ]);
  });

  it('requires future migrations to be checksum-tracked', () => {
    const baseline = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
    expect(
      findD1MigrationSafetyErrors(
        [
          { name: '0001_initial.sql', content: baseline },
          { name: '0002_add_name.sql', content: 'ALTER TABLE example ADD COLUMN name TEXT;' },
        ],
        {
          directory: 'migrations',
          checksums: { '0001_initial.sql': digest(baseline) },
        },
      ),
    ).toContain('migrations/0002_add_name.sql must have an exact SHA-256 checksum entry before it can ship.');
  });

  it('freezes a future migration after its checksum is registered', () => {
    const baseline = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
    const registered = 'ALTER TABLE example ADD COLUMN name TEXT;';
    const edited = 'ALTER TABLE example ADD COLUMN display_name TEXT;';
    expect(
      findD1MigrationSafetyErrors(
        [
          { name: '0001_initial.sql', content: baseline },
          { name: '0002_add_name.sql', content: edited },
        ],
        {
          directory: 'migrations',
          checksums: {
            '0001_initial.sql': digest(baseline),
            '0002_add_name.sql': digest(registered),
          },
        },
      ),
    ).toContain(
      'migrations/0002_add_name.sql is checksum-tracked D1 migration history and must remain immutable; add a new additive migration instead.',
    );
  });

  it('continues rollout-safety checks after a future migration is checksummed', () => {
    const baseline = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
    const unsafe = 'DROP TABLE example;';
    expect(
      findD1MigrationSafetyErrors(
        [
          { name: '0001_initial.sql', content: baseline },
          { name: '0002_contract.sql', content: unsafe },
        ],
        {
          directory: 'migrations',
          checksums: { '0001_initial.sql': digest(baseline), '0002_contract.sql': digest(unsafe) },
        },
      ),
    ).toContain(
      'migrations/0002_contract.sql is not expand/contract safe: DROP removes schema in place; stage the additive replacement before a separately reviewed exact-digest contract exception.',
    );
  });

  it('requires a separate exact-digest allowlist for a reviewed contract migration', () => {
    const baseline = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
    const contract = 'DROP TABLE example;';
    const checksums = { '0001_initial.sql': digest(baseline), '0002_contract.sql': digest(contract) };
    const migrations = [
      { name: '0001_initial.sql', content: baseline },
      { name: '0002_contract.sql', content: contract },
    ];

    expect(
      findD1MigrationSafetyErrors(migrations, {
        directory: 'migrations',
        checksums,
        contractAllowlist: { '0002_contract.sql': digest(contract) },
      }),
    ).toEqual([]);
    expect(
      findD1MigrationSafetyErrors(migrations, {
        directory: 'migrations',
        checksums,
        contractAllowlist: { '0002_contract.sql': digest(`${contract}\n`) },
      }),
    ).toEqual(
      expect.arrayContaining([
        'migrations/0002_contract.sql contract allowlist digest does not match the migration content.',
        'migrations/0002_contract.sql is not expand/contract safe: DROP removes schema in place; stage the additive replacement before a separately reviewed exact-digest contract exception.',
      ]),
    );
  });

  it('rejects contract exceptions for grandfathered legacy migrations', () => {
    const legacy = 'DROP TABLE example;';
    expect(
      findD1MigrationSafetyErrors([{ name: '0001_legacy.sql', content: legacy }], {
        directory: 'migrations',
        checksums: { '0001_legacy.sql': digest(legacy) },
        contractAllowlist: { '0001_legacy.sql': digest(legacy) },
      }),
    ).toContain('migrations/0001_legacy.sql contract allowlist entry is unnecessary for legacy migration history.');
  });

  it('requires new migration versions to remain contiguous', () => {
    const baseline = 'CREATE TABLE example (id TEXT PRIMARY KEY);';
    expect(
      findD1MigrationSafetyErrors(
        [
          { name: '0001_initial.sql', content: baseline },
          { name: '0003_skipped.sql', content: 'ALTER TABLE example ADD COLUMN name TEXT;' },
        ],
        {
          directory: 'migrations',
          checksums: {
            '0001_initial.sql': digest(baseline),
            '0003_skipped.sql': digest('ALTER TABLE example ADD COLUMN name TEXT;'),
          },
        },
      ),
    ).toContain('migrations/0003_skipped.sql must be migration 0002 so D1 history stays contiguous.');
  });
});
