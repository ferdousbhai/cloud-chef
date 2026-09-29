export function findWorkerRuntimeSecretErrors(config, label, guidance) {
  const secrets = config?.secrets;
  if (secrets === undefined) {
    return [];
  }

  const validShape =
    typeof secrets === 'object' &&
    secrets !== null &&
    !Array.isArray(secrets) &&
    Object.keys(secrets).every((key) => key === 'required') &&
    Array.isArray(secrets.required) &&
    secrets.required.every((name) => typeof name === 'string' && name.trim().length > 0) &&
    new Set(secrets.required).size === secrets.required.length;

  return validShape
    ? []
    : [`${label} secrets may declare only unique, non-empty names in secrets.required; ${guidance}.`];
}

export function findWorkerObservabilityErrors(
  config,
  label,
  { logsSamplingRate = 0.6, tracesSamplingRate = 0.05 } = {},
) {
  const observability = config?.observability;
  return [
    ['observability.enabled', observability?.enabled, true],
    ['observability.logs.enabled', observability?.logs?.enabled, true],
    ['observability.logs.head_sampling_rate', observability?.logs?.head_sampling_rate, logsSamplingRate],
    ['observability.traces.enabled', observability?.traces?.enabled, true],
    ['observability.traces.head_sampling_rate', observability?.traces?.head_sampling_rate, tracesSamplingRate],
  ]
    .filter(([, actual, expected]) => actual !== expected)
    .map(
      ([path, actual, expected]) =>
        `${label} ${path} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
}
