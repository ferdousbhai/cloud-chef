import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const workloadTables = [
  'agent_gc_candidates',
  'app_resource_gc_candidates',
  'chat_transcripts',
  'chats',
  'deployment_activity',
  'deployment_resources',
  'deployments',
  'runtime_controls',
];

describe('user-owned workspace D1 schema', () => {
  test('contains only chat and deployment workload metadata', () => {
    const db = database();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));

    expect(tables).toEqual(workloadTables);
  });

  test('stores a workspace reference without retaining a build artifact or connection copy', () => {
    const db = database();
    db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp)
       VALUES ('chat-1', 'user-1', 'initial-1', '2026-08-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO deployments (
         id, chat_id, user_id, connection_id, connection_generation, workspace_reference,
         status, plan_json, plan_digest, created_at, updated_at
       ) VALUES ('deployment-1', 'chat-1', 'user-1', 'connection-1', 1, 'workspace-runtime:project:1:hash',
         'awaiting_approval', '{}', 'digest', 1, 1)`,
    ).run();

    expect(db.prepare('SELECT workspace_reference, status FROM deployments').get()).toEqual({
      workspace_reference: 'workspace-runtime:project:1:hash',
      status: 'awaiting_approval',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('uses only the immutable initial ID for chat identity', () => {
    const db = database();
    const columns = db
      .prepare('PRAGMA table_info(chats)')
      .all()
      .map((row) => String(row.name));
    const indexes = db
      .prepare("PRAGMA index_list('chats')")
      .all()
      .map((row) => String(row.name));

    expect(columns).not.toContain('url_id');
    expect(indexes).not.toContain('idx_chats_active_url');
  });

  test('tracks automatic and manual project and conversation titles', () => {
    const db = database();
    const chatColumns = db
      .prepare('PRAGMA table_info(chats)')
      .all()
      .map((row) => String(row.name));
    const transcriptColumns = db
      .prepare('PRAGMA table_info(chat_transcripts)')
      .all()
      .map((row) => String(row.name));

    expect(chatColumns).toContain('description_source');
    expect(transcriptColumns).toEqual(expect.arrayContaining(['description_source', 'description_generation']));
  });

  test('moves transcript checkpoints out of D1 while preserving chat visibility', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of readdirSync('user-workspace-migrations')
      .filter((name) => name.endsWith('.sql') && name < '0007_builder_agent_transcript_authority.sql')
      .sort()) {
      db.exec(readFileSync(`user-workspace-migrations/${name}`, 'utf8'));
    }
    db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp)
       VALUES ('chat-1', 'user-1', 'initial-1', '2026-08-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_transcripts (
         chat_id, subchat_index, generation, agent_name, head_revision, head_digest,
         head_message_count, last_message_rank, part_index, transition_token, created_at, updated_at
       ) VALUES ('chat-1', 0, 0, 'agent-1', 2, 'digest', 3, 2, 0, 'transition-1', 1, 1)`,
    ).run();

    db.exec(readFileSync('user-workspace-migrations/0007_builder_agent_transcript_authority.sql', 'utf8'));

    expect(db.prepare("SELECT has_messages FROM chats WHERE id = 'chat-1'").get()).toEqual({ has_messages: 1 });
    const columns = db
      .prepare('PRAGMA table_info(chat_transcripts)')
      .all()
      .map((row) => String(row.name));
    // Per column: `not.toEqual(arrayContaining([...]))` passes as soon as one listed column is
    // absent, so it would keep passing with four of the five still there.
    for (const column of ['head_revision', 'head_digest', 'head_message_count', 'last_message_rank', 'part_index']) {
      expect(columns).not.toContain(column);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('backfills provider cleanup for projects deleted before the resource outbox existed', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));
    db.exec(readFileSync('user-workspace-migrations/0002_remove_chat_url_id.sql', 'utf8'));
    db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp, is_deleted)
       VALUES ('deleted-chat', 'user-1', 'initial-1', '2026-08-01T00:00:00.000Z', 1)`,
    ).run();

    db.exec(readFileSync('user-workspace-migrations/0003_app_resource_gc.sql', 'utf8'));

    expect(db.prepare('SELECT chat_id, not_before, attempts FROM app_resource_gc_candidates').all()).toEqual([
      { chat_id: 'deleted-chat', not_before: 0, attempts: 0 },
    ]);
  });

  test('removes the alternate URL identity without changing chat rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync('user-workspace-migrations/0001_user_workspace.sql', 'utf8'));
    db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, url_id, timestamp)
       VALUES ('chat-row', 'user-1', 'initial-1', 'old-route', '2026-08-01T00:00:00.000Z')`,
    ).run();

    db.exec(readFileSync('user-workspace-migrations/0002_remove_chat_url_id.sql', 'utf8'));

    expect(db.prepare('SELECT id, creator_id, initial_id FROM chats').get()).toEqual({
      id: 'chat-row',
      creator_id: 'user-1',
      initial_id: 'initial-1',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync('user-workspace-migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(`user-workspace-migrations/${name}`, 'utf8'));
  }
  return db;
}
