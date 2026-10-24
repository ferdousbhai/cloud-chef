import { z } from 'zod';

export const editToolParameters = z.object({
  path: z.string().describe('Absolute project file path.'),
  old_string: z.string().min(1).describe('Exact text to replace, copied from the file.'),
  new_string: z.string().describe('Replacement text. An empty string deletes old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence of old_string. Without it, old_string must occur exactly once.'),
});

/**
 * The one line numbering read and workspace search share, so a search hit names the line a read
 * prints. A BOM is dropped; CRLF ends a line everywhere, and a lone CR only in a file with no LF.
 */
export function logicalLines(content: string): string[] {
  const body = content.startsWith('﻿') ? content.slice(1) : content;
  const breaks = body.includes('\r') && !body.includes('\n') ? /\r\n|\r|\n/g : /\r\n|\n/g;
  const lines: string[] = [];
  let start = 0;
  for (let match = breaks.exec(body); match !== null; match = breaks.exec(body)) {
    lines.push(body.slice(start, match.index));
    start = match.index + match[0].length;
  }
  if (start < body.length) {
    lines.push(body.slice(start));
  }
  return lines;
}

type FileReadOptions = {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  maxLines: number;
  maxBytes: number;
};

type FileReadResult = {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
};

/** A file's text from line `offset` on, bounded by line count and bytes, with LF line breaks. */
export function readFileLines(options: FileReadOptions): FileReadResult {
  const offset = options.offset ?? 1;
  const lines = logicalLines(options.content);
  if (offset > Math.max(1, lines.length)) {
    throw new Error(`Offset ${offset} is beyond end of content (${lines.length} lines).`);
  }
  const lineLimit = Math.min(options.limit ?? options.maxLines, options.maxLines);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let index = offset - 1; index < lines.length && selected.length < lineLimit; index += 1) {
    const lineBytes = utf8Length(lines[index]!) + (selected.length === 0 ? 0 : 1);
    if (selected.length === 0 && lineBytes > options.maxBytes) {
      throw new Error(`Line ${index + 1} exceeds the ${options.maxBytes}-byte read cap.`);
    }
    if (selectedBytes + lineBytes > options.maxBytes) {
      break;
    }
    selected.push(lines[index]!);
    selectedBytes += lineBytes;
  }
  const endLine = offset + selected.length - 1;
  const result: FileReadResult = {
    path: options.path,
    content: selected.join('\n'),
    startLine: offset,
    endLine,
    totalLines: lines.length,
    truncated: endLine < lines.length,
  };
  if (result.truncated) {
    result.nextOffset = endLine + 1;
  }
  return result;
}

/** A file's text after an edit, and how many occurrences it replaced. */
type ReplacedText = { content: string; replacements: number };

/**
 * Replace `oldString` with `newString`: exactly one occurrence, or every one with `replaceAll`.
 * A read shows a CRLF file with LF breaks, so text that matches only that way is matched with the
 * file's own CRLF breaks, and the replacement is written with them too.
 */
export function replaceText(content: string, oldString: string, newString: string, replaceAll = false): ReplacedText {
  let search = oldString;
  let replacement = newString;
  let count = countOccurrences(content, search);
  if (count === 0 && content.includes('\r\n')) {
    search = oldString.replace(/\r?\n/g, '\r\n');
    replacement = newString.replace(/\r?\n/g, '\r\n');
    count = countOccurrences(content, search);
  }
  if (count === 0) {
    throw new Error('old_string was not found in the file. Read the file again and copy the text exactly.');
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string occurs ${count} times in the file. Include more surrounding text to make it unique, or set replace_all.`,
    );
  }
  return {
    content: replaceAll ? content.split(search).join(replacement) : content.replace(search, () => replacement),
    replacements: replaceAll ? count : 1,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    count += 1;
  }
  return count;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
