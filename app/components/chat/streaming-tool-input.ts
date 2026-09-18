import { z } from 'zod';
import type { CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';

/**
 * A tool input is still arriving as JSON text while the model writes it, so the invocation carries
 * either the partially decoded object the stream rebuilt or the raw JSON prefix itself. Both shapes
 * answer the only two questions a streaming title asks: which file, and how much of it so far.
 */
type StreamedToolInput = {
  path: string | null;
  /**
   * File content characters written so far. Source is overwhelmingly ASCII, so this is the byte
   * count in practice, and it never claims more than the model has actually written.
   */
  characters: number;
};

/** Tolerates the trailing garbage of a truncated object, and stops at the first closed string. */
const PATH_IN_PARTIAL_JSON = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/;

const BYTES_PER_KILOBYTE = 1_024;

const NOTHING_STREAMED: StreamedToolInput = { path: null, characters: 0 };

const rawJsonPrefixSchema = z.string();

/** Every field is optional and self-healing: this is a half-written value, not a valid tool input. */
const decodedInputSchema = z.looseObject({
  path: z.string().optional().catch(undefined),
  content: z.string().optional().catch(undefined),
  edits: z
    .array(z.looseObject({ content: z.string().optional().catch(undefined) }))
    .optional()
    .catch(undefined),
});

export function streamedToolInput(invocation: Pick<CloudChefToolInvocation, 'input'>): StreamedToolInput {
  const raw = rawJsonPrefixSchema.safeParse(invocation.input);
  if (raw.success) {
    return { path: pathFromRawJson(raw.data), characters: raw.data.length };
  }
  const decoded = decodedInputSchema.safeParse(invocation.input).data;
  if (!decoded) {
    return NOTHING_STREAMED;
  }
  const editCharacters = decoded.edits?.reduce((total, edit) => total + (edit.content?.length ?? 0), 0) ?? 0;
  return {
    path: decoded.path && decoded.path.length > 0 ? decoded.path : null,
    characters: decoded.content?.length ?? editCharacters,
  };
}

export function formatStreamedSize(characters: number): string {
  if (characters < BYTES_PER_KILOBYTE) {
    return `${characters} B`;
  }
  const kilobytes = characters / BYTES_PER_KILOBYTE;
  return kilobytes < BYTES_PER_KILOBYTE
    ? `${kilobytes.toFixed(1)} KB`
    : `${(kilobytes / BYTES_PER_KILOBYTE).toFixed(1)} MB`;
}

function pathFromRawJson(raw: string): string | null {
  const match = PATH_IN_PARTIAL_JSON.exec(raw);
  if (!match?.[1]) {
    return null;
  }
  try {
    const decoded = rawJsonPrefixSchema.safeParse(JSON.parse(`"${match[1]}"`)).data;
    return decoded && decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}
