const stagingPattern = /\bstaging\b/i;
const localEnvPattern =
  /(?:^|\s)--env-file(?:[=\s]|$)|(?:^|[\s"'`])(?:\.env(?:\.[\w.-]+)?|\.dev\.vars(?:\.[\w.-]+)?)(?=$|[\s"'`])/;

export function findMissingCommandSteps(command, label, steps) {
  if (typeof command !== "string") {
    return [`${label} must be configured.`];
  }
  const errors = [];
  let cursor = -1;
  for (const step of steps) {
    const index = command.indexOf(step, cursor + 1);
    if (index === -1) {
      errors.push(`${label} must run ${JSON.stringify(step)} in order.`);
    } else {
      cursor = index;
    }
  }
  return errors;
}

export function findMissingProvisionScriptPatternErrors(
  content,
  label,
  requiredPatterns,
) {
  return requiredPatterns
    .filter(({ pattern }) => !pattern.test(content))
    .map(({ description }) => `${label} must ${description}.`);
}

export function workflowPathsFromDirectoryEntries(entries) {
  return entries
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => `.github/workflows/${entry}`)
    .sort();
}

export function startsLocalDevServer(content) {
  return /\b(?:wrangler|cf)\s+dev\b|\bvite\s+(?:--host|dev)\b/.test(content);
}

export function targetsStaging(...values) {
  return values.some((value) => stagingPattern.test(value));
}

export function loadsLocalEnvFiles(content) {
  return localEnvPattern.test(content);
}
