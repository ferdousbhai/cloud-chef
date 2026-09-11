/**
 * Ratchet every Oxlint finding against a recorded baseline.
 *
 * Oxlint reports 1,600+ anti-slop findings against this repository. Nearly all of them are one
 * architectural pattern: Durable Object RPC entry points that accept `unknown` and validate with
 * hand-rolled `record()`/`requireString()`/`typeof` guards, where the plugin wants a named domain
 * type parsed at the boundary. Converting that is a real migration, not a lint cleanup.
 *
 * The two obvious responses are both wrong. Leaving `oxlint` in the blocking lint gate makes
 * `pnpm run validate` unpassable, so nothing can be handed off — the repository's own review rule
 * becomes unsatisfiable. Downgrading or disabling the rules throws away the signal and is
 * explicitly what the install-anti-slop skill forbids.
 *
 * So every rule stays at `error` and every finding stays reported; this script only decides what
 * *fails the build*. A finding already present when the baseline was taken is debt, counted and
 * visible. A finding beyond it is a regression and fails.
 *
 * The count can only go down, and `--update` is what enforces that rather than what undermines it:
 * it refuses to record any (file, rule) count above the one already there. Accepting new debt is
 * possible but has to be asked for by name, so it is a decision in a diff rather than a reflex
 * when the build goes red.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASELINE_PATH = fileURLToPath(new URL('oxlint-baseline.json', import.meta.url));

const RULE_CODE = /^(?<plugin>[a-z-]+)\((?<name>[a-z-]+)\)$/;

/**
 * Errors Oxlint could not attribute to a rule: a file it failed to parse, or a plugin that failed
 * to load. The baseline is keyed by (file, rule), so an uncoded finding has nowhere to be recorded
 * and used to be dropped from the tally entirely — and because `lint:oxlint` is a pipeline, the
 * pipeline's status is this script's, so Oxlint's own non-zero exit was swallowed with it. A file
 * nothing could lint then passed the gate. These fail the build and cannot be baselined away.
 */
function uncodedErrors(diagnostics) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 'error' && !RULE_CODE.test(diagnostic.code ?? ''));
}

/**
 * Every rule Oxlint reports, not just the vendored plugin's.
 *
 * Scoping this to `anti-slop(...)` left the core rules gated by nothing at all: `pnpm run lint`
 * filtered them out and exited 0 while fourteen real findings sat in the tree. A baseline that
 * silently ignores a whole class of rule is worse than no baseline, because it looks like one.
 */
export function tallyDiagnostics(diagnostics) {
  const counts = {};
  for (const diagnostic of diagnostics) {
    const rule = RULE_CODE.exec(diagnostic.code ?? '')?.groups;
    if (!rule || typeof diagnostic.filename !== 'string') {
      continue;
    }
    const key = `${rule.plugin}/${rule.name}`;
    counts[diagnostic.filename] ??= {};
    counts[diagnostic.filename][key] = (counts[diagnostic.filename][key] ?? 0) + 1;
  }
  return counts;
}

export function compareToBaseline(current, baseline) {
  const regressions = [];
  const improvements = [];
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const now = current[file] ?? {};
    const before = baseline[file] ?? {};
    for (const rule of [...new Set([...Object.keys(now), ...Object.keys(before)])].sort()) {
      const nowCount = now[rule] ?? 0;
      const beforeCount = before[rule] ?? 0;
      if (nowCount > beforeCount) {
        regressions.push({ file, rule, baseline: beforeCount, current: nowCount });
      } else if (nowCount < beforeCount) {
        improvements.push({ file, rule, baseline: beforeCount, current: nowCount });
      }
    }
  }
  return { regressions, improvements };
}

export function total(counts) {
  return Object.values(counts).reduce((sum, rules) => sum + Object.values(rules).reduce((a, b) => a + b, 0), 0);
}

/**
 * Read Oxlint's report from stdin rather than spawning it, so `oxlint` stays a visible binary in
 * the package script (knip cannot see a dependency invoked from inside a module) and this file
 * stays a pure function of its input. Oxlint exits non-zero when findings exist; in a shell
 * pipeline the pipeline's status is the last command's, so that does not mask this check.
 */
async function readReport() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error('Oxlint produced no JSON report on stdin. Run: pnpm exec oxlint --format=json');
  }
  const report = JSON.parse(text.slice(start));
  if (!Array.isArray(report.diagnostics)) {
    throw new Error('Oxlint JSON report did not contain diagnostics.');
  }
  return report.diagnostics;
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).counts ?? {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function main() {
  const diagnostics = await readReport();
  const uncoded = uncodedErrors(diagnostics);
  if (uncoded.length > 0) {
    console.error(`Oxlint reported ${uncoded.length} error(s) carrying no rule code:\n`);
    for (const diagnostic of uncoded) {
      console.error(`  ${diagnostic.filename ?? '<unknown file>'}  ${diagnostic.message ?? ''}`);
    }
    console.error(
      '\nThese cannot be baselined: a file Oxlint cannot parse is linted by nothing. Fix the file,\n' +
        'or the plugin that failed to load.',
    );
    process.exitCode = 1;
    return;
  }
  const current = tallyDiagnostics(diagnostics);

  if (process.argv.includes('--update')) {
    const baseline = readBaseline();
    const { regressions } = compareToBaseline(current, baseline);
    if (regressions.length > 0 && !process.argv.includes('--accept-debt')) {
      console.error(`Refusing to record ${regressions.length} new finding(s) as accepted debt:\n`);
      for (const { file, rule, baseline: before, current: now } of regressions) {
        console.error(`  ${file}  ${rule}  ${before} -> ${now}`);
      }
      console.error(
        '\nFix these instead. If the new debt is genuinely intended, say so explicitly:\n' +
          '  pnpm run lint:oxlint:update -- --accept-debt',
      );
      process.exitCode = 1;
      return;
    }
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ total: total(current), counts: sortedCounts(current) }, null, 2)}\n`,
      'utf8',
    );
    console.log(`Recorded Oxlint baseline: ${total(current)} findings across ${Object.keys(current).length} files.`);
    return;
  }

  const baseline = readBaseline();
  const { regressions, improvements } = compareToBaseline(current, baseline);

  if (regressions.length > 0) {
    console.error(`New Oxlint findings beyond the recorded baseline (${regressions.length}):\n`);
    for (const { file, rule, baseline: before, current: now } of regressions) {
      console.error(`  ${file}  ${rule}  ${before} -> ${now}`);
    }
    console.error(
      '\nFix these rather than re-baselining. Prefer inference, `as const`, `satisfies`, named owner\n' +
        'contracts, and boundary parsing. Do not weaken rule severity or add unsafe casts.\n' +
        'Accepting new debt has to be explicit: pnpm run lint:oxlint:update -- --accept-debt',
    );
    process.exitCode = 1;
    return;
  }

  const reclaimed = improvements.reduce((sum, entry) => sum + (entry.baseline - entry.current), 0);
  console.log(`oxlint: ${total(current)} known findings, no regressions.`);
  if (reclaimed > 0) {
    console.log(`${reclaimed} baselined finding(s) are now fixed. Lock the gain in with: pnpm run lint:oxlint:update`);
  }
}

function sortedCounts(counts) {
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.keys(counts[file])
            .sort()
            .map((rule) => [rule, counts[file][rule]]),
        ),
      ]),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
