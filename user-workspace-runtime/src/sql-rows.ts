export function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
  return undefined;
}

/**
 * Add a column a Durable Object's table lacks when it was created before the column existed:
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table as it was.
 */
export function addMissingColumn(
  sql: Pick<SqlStorage, 'exec'>,
  table: string,
  column: string,
  definition: string,
): void {
  if (![...sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)].some((row) => row.name === column)) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
