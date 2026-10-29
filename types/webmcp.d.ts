/**
 * WebMCP's page API, a W3C Web Machine Learning Community Group draft
 * (https://webmachinelearning.github.io/webmcp/): `document.modelContext` in the current draft, and
 * `navigator.modelContext` in Chrome's early preview. Optional, since most browsers have neither.
 */
type WebMcpToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** A JSON value, as tools take and give them. */
type WebMcpJson = string | number | boolean | null | readonly WebMcpJson[] | { readonly [key: string]: WebMcpJson };

/** What an agent sends a tool: the JSON object its `inputSchema` describes, parsed by the tool before use. */
type WebMcpToolInput = { readonly [key: string]: WebMcpJson } | undefined;

type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  /** A JSON Schema of the input. */
  inputSchema: object;
  annotations: { readOnlyHint: boolean };
  execute: (input: WebMcpToolInput) => Promise<WebMcpToolResult>;
};

type WebMcpModelContext = {
  registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => Promise<void> | void;
  /** Chrome's early preview only; the current draft unregisters by aborting the signal. */
  unregisterTool?: (name: string) => void;
};

interface Document {
  readonly modelContext?: WebMcpModelContext;
}

interface Navigator {
  readonly modelContext?: WebMcpModelContext;
}
