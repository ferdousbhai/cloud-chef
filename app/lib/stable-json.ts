/**
 * JSON with every object's keys written in sorted order, so equal values serialize the same whatever
 * order their keys were set in: how a tool call's arguments are compared when it is replayed.
 */
export function stableJson(value: Parameters<typeof JSON.stringify>[0]): string | undefined {
  return JSON.stringify(value, (_key, field) =>
    field instanceof Object && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : field,
  );
}
