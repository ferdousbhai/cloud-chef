/**
 * User-visible copy has one definition. Tests assert against that definition; they never
 * transcribe it.
 *
 * This exists because of a real break: the homepage lede changed from "deploys your app inside"
 * to "deploys it inside", and `e2e/built-browser.spec.ts` carried a hand-copied regex of the old
 * wording. `pnpm run validate` stayed green — the browser gate needs Chromium and runs outside it —
 * so the only signal was a red build after the change had already shipped.
 *
 * The gate itself cannot run here, but this can: a transcribed sentence is detectable from the
 * source alone, without a browser. So the class of break is caught at validate time even though
 * the test that would have failed is not run.
 *
 * What it guarantees, precisely: no browser-gate file may contain a literal that matches copy the
 * app currently defines. It is a prevention, not a staleness detector — once the wording has
 * drifted, the stale literal no longer matches the constant and nothing but the browser can tell.
 * That is the point: the transcription is refused at the moment it is written, so it is never
 * around to go stale.
 */
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COPY_MODULE = join(ROOT, 'app/lib/trust.ts');

/** Prose worth protecting: four or more words. Shorter strings are labels, ids, and selectors. */
const MIN_WORDS = 4;

function proseLiterals(source) {
  const found = [];
  // Quoted strings, template literals, and regex literals alike — a transcribed sentence is equally
  // brittle in any of them. Backslashes stay inside the bodies on purpose: excluding them skipped
  // every regex that escapes a character, which is most of them, including `/deploys your app\./`.
  // `(?!\*)` keeps a single-line `/* … */` comment from reading as a regex literal.
  const pattern = /'([^'\n]{16,})'|"([^"\n]{16,})"|`([^`\n]{16,})`|\/(?!\*)([^/\n]{16,})\//g;
  for (const match of source.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!raw) {
      continue;
    }
    // Unescaped so the violation prints the sentence a reader recognises, not the pattern.
    const text = raw.replace(/\\([.*+?^${}()|[\]\\/])/g, '$1').trim();
    if (text.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length >= MIN_WORDS) {
      found.push({ text, index: match.index ?? 0 });
    }
  }
  return found;
}

// Punctuation, dash flavour, and quote flavour are all noise here: `operator’s` and `operator's`
// are the same sentence, and collapsing every non-alphanumeric run to one space is what makes them
// compare equal. Letters and digits survive untouched, so two sentences that differ in any word or
// number stay different.
const normalize = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function listFiles(dir, extension) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(full, extension);
    }
    return entry.name.endsWith(extension) ? [full] : [];
  });
}

const copySource = await readFile(COPY_MODULE, 'utf8');
const copyConstants = [...copySource.matchAll(/(?:export const (\w+)[^=]*=\s*|(\w+):\s*)'([^']{16,})'/g)]
  .map(([, exported, key, value]) => ({ name: exported ?? key, value: normalize(value) }))
  .filter(({ value }) => value.split(' ').length >= MIN_WORDS);

const targets = [...listFiles(join(ROOT, 'e2e'), '.ts'), join(ROOT, 'scripts/verify-built-ssr.mjs')];

const violations = [];
for (const file of targets) {
  const source = await readFile(file, 'utf8');
  for (const { text, index } of proseLiterals(source)) {
    const normalized = normalize(text);
    const duplicated = copyConstants.find(({ value }) => value.includes(normalized) || normalized.includes(value));
    if (duplicated) {
      violations.push({ file: relative(ROOT, file), line: lineOf(source, index), text, constant: duplicated.name });
    }
  }
}

if (violations.length > 0) {
  console.error('Transcribed copy found. Import the constant instead — a copy of a sentence goes stale silently.\n');
  for (const { file, line, text, constant } of violations) {
    console.error(`  ${file}:${line}`);
    console.error(`    "${text}"`);
    console.error(`    duplicates ${constant} in app/lib/trust.ts\n`);
  }
  process.exitCode = 1;
} else {
  console.log(`Verified ${targets.length} browser-gate files assert copy by import, not transcription.`);
}
