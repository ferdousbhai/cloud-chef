import { z } from 'zod';

const LINE_EDIT_BASE_TAG_HEX_LENGTH = 24;
const LINE_EDIT_MAX_OPERATIONS = 100;

const replacementSchema = z
  .object({
    startLine: z.number().int().min(1).describe('First original line to replace, inclusive.'),
    endLine: z.number().int().min(1).describe('Last original line to replace, inclusive.'),
    content: z.string().describe('Complete replacement content. Use an empty string to delete the selected lines.'),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: 'endLine must be greater than or equal to startLine.',
    path: ['endLine'],
  });

const insertionSchema = z
  .object({
    afterLine: z
      .number()
      .int()
      .min(0)
      .describe('Original line after which to insert. Use 0 to insert before the first line.'),
    content: z.string().min(1).describe('Content to insert.'),
  })
  .strict();

const textReplacementSchema = z
  .object({
    oldText: z
      .string()
      .min(1)
      .describe(
        'Exact current text to replace, copied from the file without the "N:" line-number prefixes. Must occur exactly once.',
      ),
    newText: z.string().describe('Replacement text. Use an empty string to delete oldText.'),
  })
  .strict();

const lineEditOperationSchema = z.union([textReplacementSchema, replacementSchema, insertionSchema]);
export type LineEditOperation = z.infer<typeof lineEditOperationSchema>;

export const lineEditToolParameters = z.object({
  path: z.string().describe('Absolute project file path.'),
  base: z
    .string()
    .regex(new RegExp(`^[A-F0-9]{${LINE_EDIT_BASE_TAG_HEX_LENGTH}}$`))
    .describe('Snapshot tag returned by the latest read or successful edit of this file.'),
  edits: z
    .array(lineEditOperationSchema)
    .min(1)
    .max(LINE_EDIT_MAX_OPERATIONS)
    .describe(
      'Non-overlapping operations against the same original snapshot: {oldText,newText} exact replacements (preferred for small changes), {startLine,endLine,content} line-range replacements, or {afterLine,content} insertions.',
    ),
});

export type LineEditToolInput = z.infer<typeof lineEditToolParameters>;

type LineAnchoredReadOptions = {
  path: string;
  content: string;
  sha256: string;
  offset?: number;
  limit?: number;
  maxLines: number;
  maxBytes: number;
};

type LineAnchoredReadResult = {
  path: string;
  base: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
};

type AppliedLineEdits = {
  content: string;
  editsApplied: number;
  firstChangedLine: number;
  /** Each changed region as removed and added lines with a little surrounding context, bounded. */
  diff: string;
  /** Bracket pairs whose balance the edit changed, as notes for the model to check. */
  bracketImbalance: string[];
};

/** Unchanged lines shown on each side of a changed region in an edit's diff. */
const LINE_EDIT_DIFF_CONTEXT_LINES = 2;
/** Removed or added lines shown per region before the middle is elided. */
const LINE_EDIT_DIFF_MAX_SIDE_LINES = 16;
const LINE_EDIT_DIFF_MAX_CHARS = 6_000;
const LINE_EDIT_DIFF_MAX_LINE_CHARS = 240;
const BRACKET_PAIRS = [
  ['(', ')'],
  ['{', '}'],
  ['[', ']'],
] as const;

/** Compact display tag; edit execution always verifies it against the live full SHA-256. */
export function lineEditBaseTag(sha256: string): string {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('A line-edit base tag requires a SHA-256 file digest.');
  }
  return sha256.slice(0, LINE_EDIT_BASE_TAG_HEX_LENGTH).toUpperCase();
}

/**
 * The one line numbering read, edit, and workspace search share.
 *
 * A search hit has to name the line an edit would change and a read would print, so the three
 * cannot each decide what a line is: a stray BOM or CRLF file would otherwise shift a whole
 * edit by one line against the line the model actually saw.
 */
export function logicalLines(content: string): string[] {
  const body = content.startsWith('\uFEFF') ? content.slice(1) : content;
  return splitLines(body, usesCarriageReturnLineEndings(body)).lines;
}

/** Format a stable file snapshot as numbered lines suitable for line-anchored edits. */
export function lineAnchoredRead(options: LineAnchoredReadOptions): LineAnchoredReadResult {
  assertPositiveInteger(options.maxLines, 'maxLines');
  assertPositiveInteger(options.maxBytes, 'maxBytes');
  // The read tool's schema admits only positive integers for both.
  const offset = options.offset ?? 1;

  const lines = logicalLines(options.content);
  if (lines.length === 0) {
    if (offset !== 1) {
      throw new Error(`Offset ${offset} is beyond end of content (0 lines).`);
    }
    return {
      path: options.path,
      base: lineEditBaseTag(options.sha256),
      content: '',
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
    };
  }
  if (offset > lines.length) {
    throw new Error(`Offset ${offset} is beyond end of content (${lines.length} lines).`);
  }

  const lineLimit = Math.min(options.limit ?? options.maxLines, options.maxLines);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let lineIndex = offset - 1; lineIndex < lines.length && selected.length < lineLimit; lineIndex += 1) {
    const rendered = `${lineIndex + 1}:${lines[lineIndex]}`;
    const renderedBytes = utf8Length(rendered) + (selected.length === 0 ? 0 : 1);
    if (selected.length === 0 && renderedBytes > options.maxBytes) {
      throw new Error(`Line ${lineIndex + 1} exceeds the ${options.maxBytes}-byte read cap.`);
    }
    if (selectedBytes + renderedBytes > options.maxBytes) {
      break;
    }
    selected.push(rendered);
    selectedBytes += renderedBytes;
  }

  const endLine = offset + selected.length - 1;
  const truncated = endLine < lines.length;
  const result: LineAnchoredReadResult = {
    path: options.path,
    base: lineEditBaseTag(options.sha256),
    content: selected.join('\n'),
    startLine: offset,
    endLine,
    totalLines: lines.length,
    truncated,
  };
  if (truncated) {
    result.nextOffset = endLine + 1;
  }
  return result;
}

/**
 * Apply every operation to the same original snapshot, never incrementally. The operations are the
 * ones `lineEditToolParameters` parsed: their count, line numbers, and contents already hold its bounds.
 */
export function applyLineEdits(original: string, operations: readonly LineEditOperation[]): AppliedLineEdits {
  const parsed = parseText(original);
  const located = locateText(parsed);
  const textOperations: { operation: { oldText: string; newText: string }; operationIndex: number }[] = [];
  const planned: PlannedOperation[] = [];
  operations.forEach((operation, operationIndex) => {
    if ('oldText' in operation) {
      textOperations.push({ operation, operationIndex });
    } else {
      planned.push(planOperation(operation, operationIndex, parsed));
    }
  });
  planned.push(...planTextReplacements(textOperations, parsed, located));
  assertOperationsDoNotOverlap(planned);

  const nextLines = applyPlannedOperations(parsed, planned);
  const content = parsed.bom + nextLines.map(({ text, ending }) => text + ending).join('');
  if (content === original) {
    throw new Error('The line edit produced no changes.');
  }
  return {
    content,
    editsApplied: operations.length,
    firstChangedLine: Math.min(...planned.map((operation) => operation.index + 1)),
    diff: renderDiff(
      parsed.lines,
      nextLines.map(({ text }) => text),
      planned,
    ),
    bracketImbalance: bracketImbalance(parsed.lines, planned),
  };
}

/** A line of the edited file, with the ending it is written with ('' for an unterminated last line). */
type EditedLine = { text: string; ending: string; insertedWithFinalNewline?: boolean };

/**
 * Splice every operation into the original lines, keeping each untouched line's own ending, so an
 * edit rewrites only the lines it changes — a file that mixes CRLF and LF keeps both.
 *
 * A replaced region's new lines take the endings of the lines they replace, position by position,
 * and its last line takes the replaced region's last ending; inserted lines take the file's first
 * ending. Afterwards every line but the last is terminated, and the last is terminated exactly when
 * the file was — or, for content inserted at the very end, when that content was.
 */
function applyPlannedOperations(parsed: ParsedText, planned: readonly PlannedOperation[]): EditedLine[] {
  const next: EditedLine[] = parsed.lines.map((text, index) => ({ text, ending: parsed.endings[index]! }));
  for (const operation of [...planned].sort(compareForApplication)) {
    const replaced = next.slice(operation.index, operation.index + operation.deleteCount);
    const count = operation.contentLines.length;
    const added = operation.contentLines.map((text, position): EditedLine => {
      const last = position === count - 1;
      if (operation.kind === 'insert') {
        return last
          ? {
              text,
              ending: operation.contentHasFinalNewline ? parsed.defaultEnding : '',
              insertedWithFinalNewline: operation.contentHasFinalNewline,
            }
          : { text, ending: parsed.defaultEnding };
      }
      const source = last ? replaced.at(-1) : replaced[Math.min(position, replaced.length - 1)];
      return { text, ending: source?.ending ?? parsed.defaultEnding };
    });
    next.splice(operation.index, operation.deleteCount, ...added);
  }

  const originalLastEnding = parsed.endings.at(-1) ?? '';
  const fileHadFinalNewline = originalLastEnding !== '';
  for (const [index, line] of next.entries()) {
    if (index < next.length - 1) {
      if (line.ending === '') {
        line.ending = parsed.defaultEnding;
      }
      continue;
    }
    if (!fileHadFinalNewline && line.insertedWithFinalNewline !== true) {
      line.ending = '';
    } else if (line.ending === '') {
      line.ending = fileHadFinalNewline ? originalLastEnding : parsed.defaultEnding;
    }
  }
  return next;
}

type LocatedText = {
  /** The logical lines joined with LF, plus the final newline when the file has one. */
  text: string;
  /** Offset of each line's first character; one more entry than lines when the text ends in a newline. */
  lineStarts: number[];
};

function locateText(parsed: ParsedText): LocatedText {
  const hasFinalNewline = (parsed.endings.at(-1) ?? '') !== '';
  const text = parsed.lines.join('\n') + (hasFinalNewline ? '\n' : '');
  const lineStarts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1);
  }
  return { text, lineStarts };
}

function lineIndexAt(located: LocatedText, offset: number): number {
  let low = 0;
  let high = located.lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (located.lineStarts[middle]! <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** One exact-text replacement, located in the file. */
type TextMatch = {
  operationIndex: number;
  matchStart: number;
  matchEnd: number;
  newText: string;
  startIndex: number;
  /** The line holding the position just after the match. */
  endPositionIndex: number;
  endIndex: number;
};

/**
 * Resolve exact-text replacements to the whole original lines they touch, so they plan, overlap,
 * and apply exactly like line-range replacements.
 *
 * Each match must be unique: a replacement that could land in two places is exactly the silent
 * damage this form exists to prevent. Replacements whose lines meet but whose text does not — two
 * names on one line — become one replacement of those lines; replacements whose text overlaps are
 * refused.
 */
function planTextReplacements(
  operations: readonly { operation: { oldText: string; newText: string }; operationIndex: number }[],
  parsed: ParsedText,
  located: LocatedText,
): PlannedReplacement[] {
  const matches = operations
    .map(({ operation, operationIndex }) => locateTextReplacement(operation, operationIndex, parsed, located))
    .sort((left, right) => left.matchStart - right.matchStart);
  const clusters: TextMatch[][] = [];
  for (const match of matches) {
    const cluster = clusters.at(-1);
    const previous = cluster?.at(-1);
    if (cluster && previous && match.startIndex <= Math.max(...cluster.map(({ endIndex }) => endIndex))) {
      if (match.matchStart < previous.matchEnd) {
        throw new Error(`edits[${previous.operationIndex}] and edits[${match.operationIndex}] overlap.`);
      }
      cluster.push(match);
    } else {
      clusters.push([match]);
    }
  }
  return clusters.map((cluster) => planTextCluster(cluster, parsed, located));
}

function planTextCluster(cluster: readonly TextMatch[], parsed: ParsedText, located: LocatedText): PlannedReplacement {
  const first = cluster[0]!;
  const startIndex = first.startIndex;
  const endIndex = Math.max(...cluster.map((match) => match.endIndex));
  const regionStart = located.lineStarts[startIndex]!;
  const regionEnd = regionStart + parsed.lines.slice(startIndex, endIndex + 1).join('\n').length;
  let replacement = '';
  let cursor = regionStart;
  for (const match of cluster) {
    replacement += located.text.slice(cursor, match.matchStart) + match.newText;
    cursor = match.matchEnd;
  }
  replacement += located.text.slice(Math.min(cursor, regionEnd), regionEnd);
  const consumedFinalNewline = cluster.some((match) => match.endPositionIndex > match.endIndex);
  if (consumedFinalNewline && replacement.endsWith('\n')) {
    // The match consumed the file's final newline, which the rejoin restores on its own.
    replacement = replacement.slice(0, -1);
  }
  return {
    kind: 'replace',
    operationIndex: first.operationIndex,
    index: startIndex,
    deleteCount: endIndex - startIndex + 1,
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    // Deleting through the end of the file leaves no line behind, rather than an empty one.
    contentLines: consumedFinalNewline && replacement === '' ? [] : replacement.split('\n'),
  };
}

function locateTextReplacement(
  operation: { oldText: string; newText: string },
  operationIndex: number,
  parsed: ParsedText,
  located: LocatedText,
): TextMatch {
  const oldText = normalizeLineBreaks(operation.oldText, parsed.carriageReturnBreaks);
  const newText = normalizeLineBreaks(operation.newText, parsed.carriageReturnBreaks);
  const occurrences = countOccurrences(located.text, oldText);
  if (occurrences === 0) {
    throw new Error(
      `edits[${operationIndex}].oldText was not found. Copy it exactly from the latest read, including whitespace and without the "N:" line-number prefixes.`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `edits[${operationIndex}].oldText occurs ${occurrences} times. Include enough surrounding text to make it unique, or use a line range.`,
    );
  }
  const matchStart = located.text.indexOf(oldText);
  const matchEnd = matchStart + oldText.length;
  // The line holding the position just after the match: a match that ends with a newline takes
  // the next line too, whole, as its suffix, so deleting "line\n" removes the line.
  const endPositionIndex = lineIndexAt(located, matchEnd);
  return {
    operationIndex,
    matchStart,
    matchEnd,
    newText,
    startIndex: lineIndexAt(located, matchStart),
    endPositionIndex,
    endIndex: Math.min(endPositionIndex, parsed.lines.length - 1),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    count += 1;
  }
  return count;
}

/**
 * The changed regions as the model should check them: removed lines under their original numbers,
 * added lines and context under the new numbers a following read would print.
 */
function renderDiff(before: readonly string[], after: readonly string[], planned: readonly PlannedOperation[]): string {
  const hunks: string[] = [];
  let shift = 0;
  let used = 0;
  const ordered = [...planned].sort((left, right) => left.index - right.index || left.deleteCount - right.deleteCount);
  for (const [position, operation] of ordered.entries()) {
    const newStart = operation.index + shift;
    const added = operation.contentLines.length;
    shift += added - operation.deleteCount;
    const lines: string[] = [
      `@@ original ${rangeLabel(operation.index, operation.deleteCount)} -> new ${rangeLabel(newStart, added)} @@`,
    ];
    for (let index = Math.max(0, newStart - LINE_EDIT_DIFF_CONTEXT_LINES); index < newStart; index += 1) {
      lines.push(diffLine(' ', index, after[index]!));
    }
    lines.push(
      ...elided(
        before.slice(operation.index, operation.index + operation.deleteCount),
        (text, offset) => diffLine('-', operation.index + offset, text),
        'removed',
      ),
      ...elided(
        after.slice(newStart, newStart + added),
        (text, offset) => diffLine('+', newStart + offset, text),
        'added',
      ),
    );
    const contextEnd = Math.min(after.length, newStart + added + LINE_EDIT_DIFF_CONTEXT_LINES);
    for (let index = newStart + added; index < contextEnd; index += 1) {
      lines.push(diffLine(' ', index, after[index]!));
    }
    const hunk = lines.join('\n');
    if (used + hunk.length > LINE_EDIT_DIFF_MAX_CHARS) {
      hunks.push(`… ${ordered.length - position} more changed region(s) omitted; read the file to check them.`);
      break;
    }
    hunks.push(hunk);
    used += hunk.length + 1;
  }
  return hunks.join('\n');
}

function rangeLabel(index: number, count: number): string {
  if (count === 0) {
    return `after line ${index}`;
  }
  return count === 1 ? `line ${index + 1}` : `lines ${index + 1}-${index + count}`;
}

function diffLine(marker: ' ' | '-' | '+', index: number, text: string): string {
  const shown =
    text.length <= LINE_EDIT_DIFF_MAX_LINE_CHARS ? text : `${text.slice(0, LINE_EDIT_DIFF_MAX_LINE_CHARS)}…`;
  return `${marker}${index + 1}:${shown}`;
}

function elided(lines: readonly string[], render: (text: string, offset: number) => string, label: string): string[] {
  if (lines.length <= LINE_EDIT_DIFF_MAX_SIDE_LINES) {
    return lines.map(render);
  }
  const head = LINE_EDIT_DIFF_MAX_SIDE_LINES / 2;
  const tailStart = lines.length - head;
  return [
    ...lines.slice(0, head).map(render),
    `… ${tailStart - head} more ${label} line(s)`,
    ...lines.slice(tailStart).map((text, offset) => render(text, tailStart + offset)),
  ];
}

/**
 * Bracket pairs whose open/close balance differs between the replaced and the replacement text.
 *
 * A line-range edit that drops a closing `}` or `)` it did not mean to is the commonest silent
 * damage, and it shows up as exactly this difference. It is a hint, not a parse: brackets inside
 * strings or comments count too, so the edit still applies and the caller only reports it.
 */
function bracketImbalance(before: readonly string[], planned: readonly PlannedOperation[]): string[] {
  const removed = planned
    .map((operation) => before.slice(operation.index, operation.index + operation.deleteCount).join('\n'))
    .join('\n');
  const added = planned.map((operation) => operation.contentLines.join('\n')).join('\n');
  const notes: string[] = [];
  for (const [open, close] of BRACKET_PAIRS) {
    const change = balance(added, open, close) - balance(removed, open, close);
    if (change > 0) {
      notes.push(`${change} more "${open}" than "${close}" than before (a dropped "${close}"?)`);
    } else if (change < 0) {
      notes.push(`${-change} more "${close}" than "${open}" than before (a dropped "${open}"?)`);
    }
  }
  return notes;
}

function balance(text: string, open: string, close: string): number {
  let count = 0;
  for (const character of text) {
    if (character === open) {
      count += 1;
    } else if (character === close) {
      count -= 1;
    }
  }
  return count;
}

type PlannedInsertion = {
  kind: 'insert';
  operationIndex: number;
  index: number;
  deleteCount: 0;
  afterLine: number;
  contentLines: string[];
  /** Whether the inserted content ended with a line break, which decides a new last line's ending. */
  contentHasFinalNewline: boolean;
};

type PlannedReplacement = {
  kind: 'replace';
  operationIndex: number;
  index: number;
  deleteCount: number;
  startLine: number;
  endLine: number;
  contentLines: string[];
};

type PlannedOperation = PlannedInsertion | PlannedReplacement;

type LineAnchoredOperation = Exclude<LineEditOperation, { oldText: string }>;

function planOperation(operation: LineAnchoredOperation, operationIndex: number, parsed: ParsedText): PlannedOperation {
  const totalLines = parsed.lines.length;
  if ('afterLine' in operation) {
    if (operation.afterLine > totalLines) {
      throw new Error(
        `edits[${operationIndex}].afterLine ${operation.afterLine} is beyond insertion line ${totalLines + 1}.`,
      );
    }
    const content = splitLines(operation.content, parsed.carriageReturnBreaks);
    return {
      kind: 'insert',
      operationIndex,
      index: operation.afterLine,
      deleteCount: 0,
      afterLine: operation.afterLine,
      contentLines: content.lines,
      contentHasFinalNewline: content.endings.at(-1) !== '',
    };
  }
  if (operation.endLine > totalLines) {
    throw new Error(
      `edits[${operationIndex}] deletes lines ${operation.startLine}-${operation.endLine}, but the content has ${totalLines} line(s).`,
    );
  }
  return {
    kind: 'replace',
    operationIndex,
    index: operation.startLine - 1,
    deleteCount: operation.endLine - operation.startLine + 1,
    startLine: operation.startLine,
    endLine: operation.endLine,
    contentLines: splitLines(operation.content, parsed.carriageReturnBreaks).lines,
  };
}

function assertOperationsDoNotOverlap(operations: readonly PlannedOperation[]): void {
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    const left = operations[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const right = operations[rightIndex]!;
      if (operationsConflict(left, right)) {
        throw new Error(
          `edits[${left.operationIndex}] and edits[${right.operationIndex}] overlap or share an insertion point.`,
        );
      }
    }
  }
}

function operationsConflict(left: PlannedOperation, right: PlannedOperation): boolean {
  if (left.kind === 'insert') {
    return right.kind === 'insert' ? left.afterLine === right.afterLine : insertionSplitsReplacement(left, right);
  }
  if (right.kind === 'insert') {
    return insertionSplitsReplacement(right, left);
  }
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

/** An insertion only conflicts when it lands strictly inside the replaced range, not at its edges. */
function insertionSplitsReplacement(insertion: PlannedInsertion, replacement: PlannedReplacement): boolean {
  return insertion.afterLine >= replacement.startLine && insertion.afterLine < replacement.endLine;
}

function compareForApplication(left: PlannedOperation, right: PlannedOperation): number {
  if (left.index !== right.index) {
    return right.index - left.index;
  }
  return right.deleteCount - left.deleteCount;
}

type LineEnding = '\n' | '\r\n' | '\r';

type ParsedText = {
  bom: string;
  lines: string[];
  /** Each line's own terminator; '' for a last line the file leaves unterminated. */
  endings: string[];
  /** The ending new lines are written with: the file's first, or LF for a file that has none. */
  defaultEnding: LineEnding;
  /** Whether a lone CR ends a line in this file (`usesCarriageReturnLineEndings`). */
  carriageReturnBreaks: boolean;
};

function parseText(content: string): ParsedText {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? content.slice(1) : content;
  const carriageReturnBreaks = usesCarriageReturnLineEndings(body);
  const { lines, endings } = splitLines(body, carriageReturnBreaks);
  const first = endings.find((ending) => ending !== '');
  return {
    bom,
    lines,
    endings,
    defaultEnding: first === '\r\n' || first === '\r' ? first : '\n',
    carriageReturnBreaks,
  };
}

/**
 * A lone CR ends a line only in a file that uses CR line endings throughout \u2014 one with no LF at
 * all. Anywhere else it is content: a `"\r"` inside a string literal of an LF file is part of its
 * line, and an edit elsewhere in that file must not turn it into a line break.
 */
function usesCarriageReturnLineEndings(body: string): boolean {
  return body.includes('\r') && !body.includes('\n');
}

/** Text with each of the file's own line breaks read as LF. */
function normalizeLineBreaks(text: string, carriageReturnBreaks: boolean): string {
  return text.replace(carriageReturnBreaks ? /\r\n|\r/g : /\r\n/g, '\n');
}

/** A text's lines, and each one's own terminator ('' for an unterminated last line). */
type SplitText = { lines: string[]; endings: string[] };

function splitLines(content: string, carriageReturnBreaks: boolean): SplitText {
  const lines: string[] = [];
  const endings: string[] = [];
  const breaks = carriageReturnBreaks ? /\r\n|\r|\n/g : /\r\n|\n/g;
  let start = 0;
  for (let match = breaks.exec(content); match !== null; match = breaks.exec(content)) {
    lines.push(content.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  if (start < content.length) {
    lines.push(content.slice(start));
    endings.push('');
  }
  return { lines, endings };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
