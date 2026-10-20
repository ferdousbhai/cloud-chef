import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

type ControlPlaneTestDatabase = { database: DatabaseSync; db: D1Database };

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

/** An in-memory control-plane database with every migration applied, behind the D1 API CloudChef uses. */
export function controlPlaneDatabase(): ControlPlaneTestDatabase {
  return migratedDatabase('migrations');
}

/** An in-memory user workspace database, as a workspace runtime's own D1 holds it. */
export function userWorkspaceDatabase(): ControlPlaneTestDatabase {
  return migratedDatabase('user-workspace-migrations');
}

function migratedDatabase(directory: string): ControlPlaneTestDatabase {
  const database = new sqlite.DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  for (const migration of readdirSync(directory).sort()) {
    database.exec(readFileSync(join(directory, migration), 'utf8'));
  }
  return { database, db: new SqliteD1Database(database) };
}

/** An Env with only the bindings a handler under test reads. */
export function envWith(bindings: Partial<Env>): Env {
  // SAFETY: each test passes every binding the code under test reads; the rest are never touched.
  return bindings as Env;
}

function result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  };
}

class SqliteD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: SQLInputValue[]): D1PreparedStatement {
    return new SqliteD1Statement(this.database, this.sql, values);
  }

  async first<T>(colName?: string): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values);
    if (row === undefined) {
      return null;
    }
    // SAFETY: test doubles read rows of the shape each query selects, which the caller names as T.
    return (colName === undefined ? row : row[colName]) as T;
  }

  async run<T>(): Promise<D1Result<T>> {
    const { changes } = this.database.prepare(this.sql).run(...this.values);
    return result<T>([], Number(changes));
  }

  async all<T>(): Promise<D1Result<T>> {
    // SAFETY: as in `first`, rows have the shape the query selects, which the caller names as T.
    return result(this.database.prepare(this.sql).all(...this.values) as T[]);
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw(): Promise<never> {
    throw new Error('raw() is not part of the control-plane test database.');
  }
}

class SqliteD1Database implements D1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, query);
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.database.exec(query);
    return { count: 1, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    throw new Error('Sessions are not part of the control-plane test database.');
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not part of the control-plane test database.');
  }
}
