import { describe, expect, it } from 'vitest';
import { readDefaultBuilderModel } from './builder-model-settings.server';

/** A D1 stand-in whose one row holds `model` as the account's chosen default. */
function databaseWith(model: string | null): D1Database {
  const statement = { bind: () => statement, first: async () => ({ model }) };
  // SAFETY: `readDefaultBuilderModel` calls only `prepare(...).bind(...).first()`, which this implements.
  return { prepare: () => statement } as unknown as D1Database;
}

describe("an account's default builder model", () => {
  it('reads a Claude default saved under its old bare id as the same model under its anthropic/ id', async () => {
    await expect(readDefaultBuilderModel(databaseWith('claude-opus-5-5'), 'connection')).resolves.toBe(
      'anthropic/claude-opus-5-5',
    );
  });

  it('reads every other default, and none, as it was saved', async () => {
    await expect(readDefaultBuilderModel(databaseWith('anthropic/claude-opus-5-5'), 'c')).resolves.toBe(
      'anthropic/claude-opus-5-5',
    );
    await expect(readDefaultBuilderModel(databaseWith('@cf/zai-org/glm-5.3-flash'), 'c')).resolves.toBe(
      '@cf/zai-org/glm-5.3-flash',
    );
    await expect(readDefaultBuilderModel(databaseWith('openrouter/anthropic/claude-fable-5'), 'c')).resolves.toBe(
      'openrouter/anthropic/claude-fable-5',
    );
    await expect(readDefaultBuilderModel(databaseWith(null), 'c')).resolves.toBeNull();
  });
});
