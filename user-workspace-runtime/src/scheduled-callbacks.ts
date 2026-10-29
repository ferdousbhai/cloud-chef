import { z } from 'zod';
import { first } from './sql-rows';

type ScheduledCallbackStorage = Pick<DurableObjectStorage, 'sql' | 'setAlarm'>;

/** What a scheduled callback is woken with: for a sync retry, which backend's pull. */
const scheduledCallbackPayloadSchema = z.object({ backend: z.string().optional() });
export type ScheduledCallbackPayload = z.infer<typeof scheduledCallbackPayloadSchema>;

/**
 * Named callbacks a Durable Object runs later, on its one alarm. Sandbox 0.x's `Container.schedule`
 * did this for the runtime's classes; Sandbox 1.0 has no class to inherit it from, so it is CloudChef's.
 *
 * One row per callback: every callback here is a whole-state sweep that re-derives its next wake, so a
 * later schedule replaces an earlier one rather than stacking beside it. Rows live in the object's own
 * SQLite, so a schedule survives a restart; a callback is removed before it runs, and one that wants
 * another wake schedules itself again.
 */
export class ScheduledCallbacks<Callback extends string> {
  constructor(
    private readonly storage: ScheduledCallbackStorage,
    private readonly table: string,
  ) {}

  initialize(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         callback TEXT PRIMARY KEY,
         run_at INTEGER NOT NULL,
         payload TEXT NOT NULL
       )`,
    );
  }

  /** Run `callback` once, `delaySeconds` from now, replacing any earlier schedule for it. */
  async schedule(delaySeconds: number, callback: Callback, payload: ScheduledCallbackPayload): Promise<void> {
    this.storage.sql.exec(
      `INSERT INTO ${this.table} (callback, run_at, payload) VALUES (?, ?, ?)
       ON CONFLICT(callback) DO UPDATE SET run_at = excluded.run_at, payload = excluded.payload`,
      callback,
      Date.now() + Math.max(0, delaySeconds) * 1_000,
      JSON.stringify(payload),
    );
    await this.armNextAlarm();
  }

  delete(callback: Callback): void {
    this.storage.sql.exec(`DELETE FROM ${this.table} WHERE callback = ?`, callback);
  }

  has(callback: Callback): boolean {
    return (
      first(this.storage.sql.exec(`SELECT 1 AS present FROM ${this.table} WHERE callback = ?`, callback)) !== undefined
    );
  }

  /**
   * Run every callback that is due, from the object's `alarm()`. A failing callback is logged and does
   * not stop the others; the alarm is then armed for the next one still waiting.
   */
  async runDue(run: (callback: string, payload: ScheduledCallbackPayload) => Promise<void>): Promise<void> {
    const now = Date.now();
    const due = [
      ...this.storage.sql.exec<{ callback: string; payload: string }>(
        `SELECT callback, payload FROM ${this.table} WHERE run_at <= ? ORDER BY run_at`,
        now,
      ),
    ];
    for (const { callback, payload } of due) {
      this.storage.sql.exec(`DELETE FROM ${this.table} WHERE callback = ? AND run_at <= ?`, callback, now);
      try {
        await run(callback, scheduledCallbackPayloadSchema.parse(JSON.parse(payload)));
      } catch (error) {
        console.error('Scheduled callback failed', {
          callback,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.armNextAlarm();
  }

  private async armNextAlarm(): Promise<void> {
    const next = first(
      this.storage.sql.exec<{ run_at: number }>(`SELECT run_at FROM ${this.table} ORDER BY run_at LIMIT 1`),
    );
    if (next) {
      await this.storage.setAlarm(Math.max(Date.now(), next.run_at));
    }
  }
}
