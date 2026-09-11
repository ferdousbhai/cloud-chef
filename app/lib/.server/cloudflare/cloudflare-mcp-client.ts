import { z } from 'zod';

export const CLOUDFLARE_MCP_ENDPOINT = 'https://mcp.cloudflare.com/mcp';
export const CLOUDFLARE_MCP_PROTOCOL_VERSION = '2025-11-25';
const CLOUDFLARE_MCP_CONNECT_TIMEOUT_MS = 10_000;
const CLOUDFLARE_MCP_LIST_TIMEOUT_MS = 10_000;
const CLOUDFLARE_MCP_CALL_TIMEOUT_MS = 60_000;
const CLOUDFLARE_MCP_OVERALL_TIMEOUT_MS = 75_000;
export const CLOUDFLARE_MCP_MAX_TOOL_INPUT_BYTES = 64 * 1024;
const CLOUDFLARE_MCP_MAX_REQUEST_BYTES = 68 * 1024;
export const CLOUDFLARE_MCP_MAX_RESPONSE_BYTES = 64 * 1024;
export const CLOUDFLARE_MCP_MAX_NORMALIZED_CONTENT_BYTES = 48 * 1024;
export const CLOUDFLARE_MCP_PROVIDER_TRUNCATION_MARKER = '--- TRUNCATED ---';

export const CLOUDFLARE_MCP_EXPECTED_TOOL_CONTRACT = [
  { name: 'docs', requiredInputProperties: ['query'], optionalInputProperties: [] },
  { name: 'search', requiredInputProperties: ['code'], optionalInputProperties: [] },
  { name: 'execute', requiredInputProperties: ['code'], optionalInputProperties: ['account_id'] },
] as const;

type CloudflareMcpToolName = (typeof CLOUDFLARE_MCP_EXPECTED_TOOL_CONTRACT)[number]['name'];
export type CloudflareMcpFailureCode =
  | 'aborted'
  | 'authentication_failed'
  | 'compatibility_drift'
  | 'credential_unavailable'
  | 'invalid_invocation'
  | 'malformed_response'
  | 'provider_failure'
  | 'redirect_rejected'
  | 'request_too_large'
  | 'response_too_large'
  | 'timeout'
  | 'transport_failure';

export interface CloudflareMcpAccessTokenResolution {
  forceRefresh?: boolean;
}

export interface CloudflareMcpClientDependencies {
  resolveAccessToken(options?: CloudflareMcpAccessTokenResolution): Promise<string>;
  request?: typeof fetch;
}

export interface CloudflareMcpIdentity {
  userId: string;
  connectionId: string;
  connectionGeneration: number;
}

export interface CloudflareMcpOperationContext extends CloudflareMcpIdentity {
  accountId: string;
  signal: AbortSignal;
  invocationId: string;
}

export interface CloudflareMcpDocsInput {
  query: string;
}

export interface CloudflareMcpSearchInput {
  code: string;
}

export interface CloudflareMcpExecuteInput {
  code: string;
}

export interface CloudflareMcpDocsInvocation extends CloudflareMcpOperationContext {
  toolName: 'docs';
  toolInput: CloudflareMcpDocsInput;
}

export interface CloudflareMcpSearchInvocation extends CloudflareMcpOperationContext {
  toolName: 'search';
  toolInput: CloudflareMcpSearchInput;
}

export interface CloudflareMcpExecuteInvocation extends CloudflareMcpOperationContext {
  toolName: 'execute';
  toolInput: CloudflareMcpExecuteInput;
}

export type CloudflareMcpInvocation =
  CloudflareMcpDocsInvocation | CloudflareMcpSearchInvocation | CloudflareMcpExecuteInvocation;

export interface CloudflareMcpNormalizedContent {
  type: 'text';
  text: string;
}

export interface CloudflareMcpMetadata {
  requestId: string | null;
  httpStatus: number | null;
  truncated: boolean;
}

export interface CloudflareMcpSuccessOutcome {
  status: 'success';
  content: readonly CloudflareMcpNormalizedContent[];
  metadata: CloudflareMcpMetadata;
}

export interface CloudflareMcpInsufficientScopeOutcome {
  status: 'insufficient_scope';
  message: string;
  metadata: CloudflareMcpMetadata;
}

export interface CloudflareMcpFailureOutcome {
  status: 'failure';
  error: {
    code: CloudflareMcpFailureCode;
    message: string;
  };
  metadata: CloudflareMcpMetadata;
}

export interface CloudflareMcpIndeterminateOutcome {
  status: 'indeterminate';
  error: {
    code: CloudflareMcpFailureCode;
    message: string;
  };
  metadata: CloudflareMcpMetadata;
}

export type CloudflareMcpOutcome =
  | CloudflareMcpSuccessOutcome
  | CloudflareMcpInsufficientScopeOutcome
  | CloudflareMcpFailureOutcome
  | CloudflareMcpIndeterminateOutcome;

class CloudflareMcpError extends Error {
  constructor(
    readonly code: CloudflareMcpFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'CloudflareMcpError';
  }
}

export class CloudflareMcpCompatibilityError extends CloudflareMcpError {
  constructor() {
    super('compatibility_drift', 'The official Cloudflare MCP tool contract is incompatible.');
    this.name = 'CloudflareMcpCompatibilityError';
  }
}

const jsonSchemaPropertySchema = z.looseObject({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  anyOf: z.array(z.looseObject({ type: z.union([z.string(), z.array(z.string())]).optional() })).optional(),
  oneOf: z.array(z.looseObject({ type: z.union([z.string(), z.array(z.string())]).optional() })).optional(),
});
const toolInputSchema = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), jsonSchemaPropertySchema),
  required: z.array(z.string()).optional(),
});
const listedToolSchema = z.looseObject({
  name: z.string(),
  inputSchema: toolInputSchema,
});
const listToolsResultSchema = z.looseObject({
  tools: z.array(listedToolSchema),
  nextCursor: z.string().optional(),
});
const initializeResultSchema = z.looseObject({
  protocolVersion: z.string(),
  capabilities: z.looseObject({ tools: z.looseObject({}).optional() }),
  serverInfo: z.looseObject({ name: z.string(), version: z.string() }),
});
const jsonRpcEnvelopeSchema = z
  .looseObject({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z
      .looseObject({
        code: z.union([z.string(), z.number()]),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .refine((envelope) => (envelope.result === undefined) !== (envelope.error === undefined));
const callToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.literal('text'), text: z.string() })).max(32),
  isError: z.boolean().optional(),
});
const requestIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const timeoutErrorSchema = z.looseObject({ name: z.literal('TimeoutError') });

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const expectedToolNames: readonly CloudflareMcpToolName[] = ['docs', 'search', 'execute'];

type RequestStage = 'connect' | 'list' | 'call';
type RequestFailureReason =
  | 'aborted'
  | 'authentication_rejected'
  | 'malformed_response'
  | 'provider_4xx'
  | 'provider_5xx'
  | 'redirect_rejected'
  | 'request_too_large'
  | 'response_too_large'
  | 'timeout'
  | 'transport_failure';

interface ExchangeMetadata {
  requestId: string | null;
  httpStatus: number | null;
}

interface HttpExchange extends ExchangeMetadata {
  contentType: string | null;
  insufficientScope: boolean;
  responseText: string;
}

interface RequestFailureDetails extends ExchangeMetadata {
  stage: RequestStage;
  reason: RequestFailureReason;
}

interface JsonRpcRequestDetails {
  accessToken: string;
  body: string;
  signal: AbortSignal;
  stage: RequestStage;
  timeoutMs: number;
}

interface NormalizedToolResult {
  content: readonly CloudflareMcpNormalizedContent[];
  truncated: boolean;
}

interface AuthenticatedOperation<T> {
  (accessToken: string, signal: AbortSignal): Promise<T>;
}

class CloudflareMcpRequestError extends CloudflareMcpError {
  readonly stage: RequestStage;
  readonly reason: RequestFailureReason;
  readonly requestId: string | null;
  readonly httpStatus: number | null;

  constructor(details: RequestFailureDetails) {
    super(failureCode(details.reason), requestFailureMessage(details.reason));
    this.name = 'CloudflareMcpRequestError';
    this.stage = details.stage;
    this.reason = details.reason;
    this.requestId = details.requestId;
    this.httpStatus = details.httpStatus;
  }
}

class CloudflareMcpInsufficientScopeError extends CloudflareMcpRequestError {
  constructor(stage: RequestStage, exchange: ExchangeMetadata) {
    super({ stage, reason: 'provider_4xx', ...exchange });
    this.name = 'CloudflareMcpInsufficientScopeError';
  }
}

/**
 * A request-scoped, stateless client for Cloudflare's official MCP server.
 * The client retains only the resolver and fetch implementation; bearer values
 * live in method-local variables and are discarded after each bounded operation.
 */
export class CloudflareMcpClient {
  readonly #resolveAccessToken: CloudflareMcpClientDependencies['resolveAccessToken'];
  readonly #request: typeof fetch;

  constructor(dependencies: CloudflareMcpClientDependencies) {
    this.#resolveAccessToken = dependencies.resolveAccessToken;
    this.#request = dependencies.request ?? fetch;
  }

  async invoke(invocation: CloudflareMcpInvocation): Promise<CloudflareMcpOutcome> {
    validateInvocation(invocation);
    const argumentsJson = toolArgumentsJson(invocation);
    enforceInputLimit(argumentsJson);
    const overallSignal = AbortSignal.any([invocation.signal, AbortSignal.timeout(CLOUDFLARE_MCP_OVERALL_TIMEOUT_MS)]);
    try {
      return await this.#withFreshAccessToken(overallSignal, async (accessToken, signal) => {
        await discoverExpectedTools(this.#request, invocation, accessToken, signal);
        return callTool(this.#request, invocation, argumentsJson, accessToken, signal);
      });
    } catch (cause) {
      if (cause instanceof CloudflareMcpCompatibilityError) {
        throw cause;
      }
      return failureOutcome(invocation, cause);
    }
  }

  async #withFreshAccessToken<T>(signal: AbortSignal, operation: AuthenticatedOperation<T>): Promise<T> {
    let authenticationRejection: CloudflareMcpRequestError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let accessToken: string | undefined;
      let authenticationRejected = false;
      try {
        const resolution =
          attempt === 0 ? this.#resolveAccessToken() : this.#resolveAccessToken({ forceRefresh: true });
        accessToken = await raceAgainstAbort(resolution, signal);
        if (!accessToken || textEncoder.encode(accessToken).byteLength > 4_096) {
          throw new CloudflareMcpError('credential_unavailable', 'The Cloudflare credential is unavailable.');
        }
        return await operation(accessToken, signal);
      } catch (cause) {
        if (cause instanceof CloudflareMcpRequestError && cause.reason === 'authentication_rejected') {
          authenticationRejected = true;
          authenticationRejection = cause;
        } else if (cause instanceof CloudflareMcpError) {
          throw cause;
        } else {
          throw new CloudflareMcpError('credential_unavailable', 'The Cloudflare credential is unavailable.');
        }
      } finally {
        accessToken = undefined;
      }
      if (!authenticationRejected || attempt === 1) {
        break;
      }
    }
    throw (
      authenticationRejection ??
      new CloudflareMcpError('authentication_failed', 'Cloudflare rejected the refreshed credential.')
    );
  }
}

async function discoverExpectedTools(
  request: typeof fetch,
  context: CloudflareMcpOperationContext,
  accessToken: string,
  signal: AbortSignal,
): Promise<ExchangeMetadata> {
  const connectSignal = AbortSignal.any([signal, AbortSignal.timeout(CLOUDFLARE_MCP_CONNECT_TIMEOUT_MS)]);
  const initializeId = `${context.invocationId}:initialize`;
  const initializeBody = JSON.stringify({
    jsonrpc: '2.0',
    id: initializeId,
    method: 'initialize',
    params: {
      protocolVersion: CLOUDFLARE_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ghostbuild', version: 'phase-4' },
    },
  });
  const initialized = await postJsonRpc(request, {
    accessToken,
    body: initializeBody,
    signal: connectSignal,
    stage: 'connect',
    timeoutMs: CLOUDFLARE_MCP_CONNECT_TIMEOUT_MS,
  });
  requireSuccessfulHttp(initialized, 'connect');
  const initializeEnvelope = parseJsonRpcEnvelope(initialized, initializeId, 'connect');
  if (initializeEnvelope.error) {
    rejectJsonRpcError(initializeEnvelope.error, initialized, 'connect');
  }
  const initializeResult = initializeResultSchema.safeParse(initializeEnvelope.result);
  if (
    !initializeResult.success ||
    initializeResult.data.protocolVersion !== CLOUDFLARE_MCP_PROTOCOL_VERSION ||
    !initializeResult.data.capabilities.tools
  ) {
    throw new CloudflareMcpCompatibilityError();
  }

  const notificationBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const notification = await postJsonRpc(request, {
    accessToken,
    body: notificationBody,
    signal: connectSignal,
    stage: 'connect',
    timeoutMs: CLOUDFLARE_MCP_CONNECT_TIMEOUT_MS,
  });
  requireSuccessfulHttp(notification, 'connect');
  if (notification.httpStatus !== 202 || notification.responseText.length > 0) {
    throw requestError('malformed_response', 'connect', notification);
  }

  const listId = `${context.invocationId}:tools-list`;
  const listBody = JSON.stringify({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} });
  const listed = await postJsonRpc(request, {
    accessToken,
    body: listBody,
    signal,
    stage: 'list',
    timeoutMs: CLOUDFLARE_MCP_LIST_TIMEOUT_MS,
  });
  requireSuccessfulHttp(listed, 'list');
  const listEnvelope = parseJsonRpcEnvelope(listed, listId, 'list');
  if (listEnvelope.error) {
    rejectJsonRpcError(listEnvelope.error, listed, 'list');
  }
  validateToolCatalog(listEnvelope.result);
  return listed;
}

async function callTool(
  request: typeof fetch,
  invocation: CloudflareMcpInvocation,
  argumentsJson: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<CloudflareMcpOutcome> {
  const callId = `${invocation.invocationId}:tools-call`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: callId,
    method: 'tools/call',
    params: { name: invocation.toolName, arguments: JSON.parse(argumentsJson) },
  });
  const exchange = await postJsonRpc(request, {
    accessToken,
    body,
    signal,
    stage: 'call',
    timeoutMs: CLOUDFLARE_MCP_CALL_TIMEOUT_MS,
  });
  requireSuccessfulHttp(exchange, 'call');
  const envelope = parseJsonRpcEnvelope(exchange, callId, 'call');
  if (envelope.error) {
    if (containsInsufficientScope(JSON.stringify(envelope.error))) {
      return insufficientScopeOutcome(invocation, exchange);
    }
    throw requestError('provider_4xx', 'call', exchange);
  }
  const parsedResult = callToolResultSchema.safeParse(envelope.result);
  if (!parsedResult.success) {
    throw requestError('malformed_response', 'call', exchange);
  }
  const normalized = normalizeToolResult(parsedResult.data, accessToken);
  const metadata = outcomeMetadata(exchange, normalized.truncated);
  if (parsedResult.data.isError) {
    const providerText = parsedResult.data.content.map((item) => item.text).join('\n');
    if (containsInsufficientScope(providerText)) {
      return insufficientScopeOutcome(invocation, exchange);
    }
    return {
      status: 'failure',
      error: { code: 'provider_failure', message: 'Cloudflare reported that the MCP tool call failed.' },
      metadata,
    };
  }
  return { status: 'success', content: normalized.content, metadata };
}

async function postJsonRpc(request: typeof fetch, details: JsonRpcRequestDetails): Promise<HttpExchange> {
  if (textEncoder.encode(details.body).byteLength > CLOUDFLARE_MCP_MAX_REQUEST_BYTES) {
    throw new CloudflareMcpRequestError({
      stage: details.stage,
      reason: 'request_too_large',
      requestId: null,
      httpStatus: null,
    });
  }
  const phaseSignal = AbortSignal.any([details.signal, AbortSignal.timeout(details.timeoutMs)]);
  let response: Response;
  try {
    response = await request(CLOUDFLARE_MCP_ENDPOINT, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${details.accessToken}`,
        'content-type': 'application/json',
        'mcp-protocol-version': CLOUDFLARE_MCP_PROTOCOL_VERSION,
      },
      body: details.body,
      signal: phaseSignal,
    });
  } catch (cause) {
    const timedOut = phaseSignal.aborted || timeoutErrorSchema.safeParse(cause).success;
    const parentTimedOut = details.signal.aborted && timeoutErrorSchema.safeParse(details.signal.reason).success;
    const reason = details.signal.aborted
      ? parentTimedOut
        ? 'timeout'
        : 'aborted'
      : timedOut
        ? 'timeout'
        : 'transport_failure';
    throw new CloudflareMcpRequestError({
      stage: details.stage,
      reason,
      requestId: null,
      httpStatus: null,
    });
  }
  const exchange = exchangeMetadata(response);
  if (response.status >= 300 && response.status < 400) {
    await discardResponseBody(response);
    throw new CloudflareMcpRequestError({ stage: details.stage, reason: 'redirect_rejected', ...exchange });
  }
  if (response.status === 401) {
    await discardResponseBody(response);
    throw new CloudflareMcpRequestError({ stage: details.stage, reason: 'authentication_rejected', ...exchange });
  }
  if (response.headers.has('mcp-session-id')) {
    await discardResponseBody(response);
    throw new CloudflareMcpCompatibilityError();
  }
  const responseText = await readBoundedResponse(response, details.stage, exchange);
  return {
    ...exchange,
    contentType: response.headers.get('content-type'),
    insufficientScope: containsInsufficientScope(response.headers.get('www-authenticate') ?? ''),
    responseText,
  };
}

async function readBoundedResponse(
  response: Response,
  stage: RequestStage,
  exchange: ExchangeMetadata,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > CLOUDFLARE_MCP_MAX_RESPONSE_BYTES) {
    await discardResponseBody(response);
    throw new CloudflareMcpRequestError({ stage, reason: 'response_too_large', ...exchange });
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > CLOUDFLARE_MCP_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudflareMcpRequestError({ stage, reason: 'response_too_large', ...exchange });
      }
      chunks.push(chunk.value);
    }
  } catch (cause) {
    if (cause instanceof CloudflareMcpRequestError) {
      throw cause;
    }
    throw new CloudflareMcpRequestError({ stage, reason: 'transport_failure', ...exchange });
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new CloudflareMcpRequestError({ stage, reason: 'malformed_response', ...exchange });
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup is best effort; the safe typed outcome from the HTTP status remains authoritative.
  }
}

function parseJsonRpcEnvelope(exchange: HttpExchange, expectedId: string, stage: RequestStage) {
  if (!exchange.contentType?.startsWith('application/json')) {
    throw requestError('malformed_response', stage, exchange);
  }
  let parsed;
  try {
    parsed = jsonRpcEnvelopeSchema.safeParse(JSON.parse(exchange.responseText));
  } catch {
    throw requestError('malformed_response', stage, exchange);
  }
  if (!parsed.success || parsed.data.id !== expectedId) {
    throw requestError('malformed_response', stage, exchange);
  }
  return parsed.data;
}

function validateToolCatalog(result: z.infer<typeof jsonRpcEnvelopeSchema>['result']): void {
  const parsed = listToolsResultSchema.safeParse(result);
  if (
    !parsed.success ||
    parsed.data.nextCursor !== undefined ||
    parsed.data.tools.length !== expectedToolNames.length
  ) {
    throw new CloudflareMcpCompatibilityError();
  }
  const toolsByName = new Map(parsed.data.tools.map((tool) => [tool.name, tool]));
  if (toolsByName.size !== expectedToolNames.length) {
    throw new CloudflareMcpCompatibilityError();
  }
  for (const contract of CLOUDFLARE_MCP_EXPECTED_TOOL_CONTRACT) {
    const tool = toolsByName.get(contract.name);
    if (
      !tool ||
      !compatibleInputSchema(tool.inputSchema, contract.requiredInputProperties, contract.optionalInputProperties)
    ) {
      throw new CloudflareMcpCompatibilityError();
    }
  }
}

function compatibleInputSchema(
  inputSchema: z.infer<typeof toolInputSchema>,
  requiredProperties: readonly string[],
  optionalProperties: readonly string[],
): boolean {
  const actualRequired = new Set(inputSchema.required ?? []);
  if (
    actualRequired.size !== requiredProperties.length ||
    !requiredProperties.every((property) => actualRequired.has(property))
  ) {
    return false;
  }
  return [...requiredProperties, ...optionalProperties].every((property) => {
    const definition = inputSchema.properties[property];
    return definition !== undefined && acceptsString(definition);
  });
}

function acceptsString(definition: z.infer<typeof jsonSchemaPropertySchema>): boolean {
  if (definition.type === 'string' || (Array.isArray(definition.type) && definition.type.includes('string'))) {
    return true;
  }
  return [...(definition.anyOf ?? []), ...(definition.oneOf ?? [])].some(
    (alternative) =>
      alternative.type === 'string' || (Array.isArray(alternative.type) && alternative.type.includes('string')),
  );
}

function rejectJsonRpcError(
  error: NonNullable<z.infer<typeof jsonRpcEnvelopeSchema>['error']>,
  exchange: ExchangeMetadata,
  stage: RequestStage,
): never {
  if (containsInsufficientScope(JSON.stringify(error))) {
    throw new CloudflareMcpInsufficientScopeError(stage, exchange);
  }
  throw requestError('provider_4xx', stage, exchange);
}

function requireSuccessfulHttp(exchange: HttpExchange, stage: RequestStage): void {
  if (exchange.httpStatus !== null && exchange.httpStatus >= 200 && exchange.httpStatus < 300) {
    return;
  }
  if (exchange.insufficientScope || containsInsufficientScope(exchange.responseText)) {
    throw new CloudflareMcpInsufficientScopeError(stage, exchange);
  }
  const reason = exchange.httpStatus !== null && exchange.httpStatus >= 500 ? 'provider_5xx' : 'provider_4xx';
  throw requestError(reason, stage, exchange);
}

function validateContext(context: CloudflareMcpOperationContext): void {
  validateIdentifier(context.userId, 512);
  validateIdentifier(context.connectionId, 512);
  validateIdentifier(context.accountId, 128);
  validateIdentifier(context.invocationId, 256);
  if (!Number.isSafeInteger(context.connectionGeneration) || context.connectionGeneration < 1) {
    throw new CloudflareMcpError('invalid_invocation', 'The Cloudflare MCP invocation identity is invalid.');
  }
}

function validateInvocation(invocation: CloudflareMcpInvocation): void {
  validateContext(invocation);
  const value = invocation.toolName === 'docs' ? invocation.toolInput.query : invocation.toolInput.code;
  if (value.length === 0 || Object.keys(invocation.toolInput).length !== 1) {
    throw new CloudflareMcpError('invalid_invocation', 'The Cloudflare MCP tool input is invalid.');
  }
}

function validateIdentifier(value: string, maximumLength: number): void {
  if (value.length === 0 || value.length > maximumLength) {
    throw new CloudflareMcpError('invalid_invocation', 'The Cloudflare MCP invocation identity is invalid.');
  }
}

function toolArgumentsJson(invocation: CloudflareMcpInvocation): string {
  if (invocation.toolName === 'docs') {
    return JSON.stringify({ query: invocation.toolInput.query });
  }
  if (invocation.toolName === 'search') {
    return JSON.stringify({ code: invocation.toolInput.code });
  }
  return JSON.stringify({ code: invocation.toolInput.code, account_id: invocation.accountId });
}

function enforceInputLimit(argumentsJson: string): void {
  if (textEncoder.encode(argumentsJson).byteLength > CLOUDFLARE_MCP_MAX_TOOL_INPUT_BYTES) {
    throw new CloudflareMcpError('request_too_large', 'The Cloudflare MCP tool input exceeds its size limit.');
  }
}

function normalizeToolResult(result: z.infer<typeof callToolResultSchema>, accessToken: string): NormalizedToolResult {
  const redacted = redactBearerTokens(result.content.map((item) => item.text).join('\n'), accessToken);
  const providerTruncated = redacted.includes(CLOUDFLARE_MCP_PROVIDER_TRUNCATION_MARKER);
  const encoded = textEncoder.encode(redacted);
  if (encoded.byteLength <= CLOUDFLARE_MCP_MAX_NORMALIZED_CONTENT_BYTES) {
    return { content: [{ type: 'text', text: redacted }], truncated: providerTruncated };
  }
  const suffix = providerTruncated
    ? `\n\n${CLOUDFLARE_MCP_PROVIDER_TRUNCATION_MARKER}`
    : '\n\n[Ghostbuild truncated the MCP response.]';
  const suffixBytes = textEncoder.encode(suffix).byteLength;
  const prefix = utf8Prefix(redacted, CLOUDFLARE_MCP_MAX_NORMALIZED_CONTENT_BYTES - suffixBytes);
  const text = prefix.includes(CLOUDFLARE_MCP_PROVIDER_TRUNCATION_MARKER) ? prefix : `${prefix}${suffix}`;
  return { content: [{ type: 'text', text }], truncated: true };
}

function redactBearerTokens(value: string, accessToken: string): string {
  const withoutBearerValues = value.replace(bearerTokenPattern, '[REDACTED]');
  return accessToken.length === 0 ? withoutBearerValues : withoutBearerValues.replaceAll(accessToken, '[REDACTED]');
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= maximumBytes) {
    return value;
  }
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function containsInsufficientScope(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('insufficient_scope') || normalized.includes('insufficient scope');
}

function outcomeMetadata(exchange: ExchangeMetadata, truncated: boolean): CloudflareMcpMetadata {
  return {
    requestId: exchange.requestId,
    httpStatus: exchange.httpStatus,
    truncated,
  };
}

function exchangeMetadata(response: Response): ExchangeMetadata {
  const requestId =
    requestIdSchema.safeParse(response.headers.get('cf-ray')).data ??
    requestIdSchema.safeParse(response.headers.get('x-request-id')).data ??
    null;
  return { requestId, httpStatus: response.status };
}

function emptyExchange(): ExchangeMetadata {
  return { requestId: null, httpStatus: null };
}

function requestError(
  reason: RequestFailureReason,
  stage: RequestStage,
  exchange: ExchangeMetadata,
): CloudflareMcpRequestError {
  return new CloudflareMcpRequestError({ stage, reason, ...exchange });
}

function failureOutcome(invocation: CloudflareMcpInvocation, cause: unknown): CloudflareMcpOutcome {
  if (cause instanceof CloudflareMcpInsufficientScopeError) {
    return insufficientScopeOutcome(invocation, cause);
  }
  const exchange = cause instanceof CloudflareMcpRequestError ? cause : emptyExchange();
  const code = cause instanceof CloudflareMcpError ? cause.code : 'transport_failure';
  const ambiguousExecute =
    invocation.toolName === 'execute' &&
    cause instanceof CloudflareMcpRequestError &&
    cause.stage === 'call' &&
    ['aborted', 'malformed_response', 'provider_5xx', 'response_too_large', 'timeout', 'transport_failure'].includes(
      cause.reason,
    );
  const metadata = outcomeMetadata(exchange, false);
  if (ambiguousExecute) {
    return {
      status: 'indeterminate',
      error: {
        code,
        message:
          'Cloudflare may have executed this operation, but Ghostbuild could not confirm the result. Reconcile with a read before retrying.',
      },
      metadata,
    };
  }
  return {
    status: 'failure',
    error: { code, message: safeFailureMessage(code) },
    metadata,
  };
}

function insufficientScopeOutcome(
  invocation: CloudflareMcpInvocation,
  exchange: ExchangeMetadata,
): CloudflareMcpInsufficientScopeOutcome {
  return {
    status: 'insufficient_scope',
    message: 'Cloudflare denied this operation because the current grant has insufficient scope.',
    metadata: outcomeMetadata(exchange, false),
  };
}

/** A provider status is reported as one provider failure; every other reason keeps its own code. */
const FAILURE_CODES = {
  aborted: 'aborted',
  authentication_rejected: 'authentication_failed',
  malformed_response: 'malformed_response',
  provider_4xx: 'provider_failure',
  provider_5xx: 'provider_failure',
  redirect_rejected: 'redirect_rejected',
  request_too_large: 'request_too_large',
  response_too_large: 'response_too_large',
  timeout: 'timeout',
  transport_failure: 'transport_failure',
} satisfies Record<RequestFailureReason, CloudflareMcpFailureCode>;

function failureCode(reason: RequestFailureReason): CloudflareMcpFailureCode {
  return FAILURE_CODES[reason];
}

function requestFailureMessage(reason: RequestFailureReason): string {
  return safeFailureMessage(failureCode(reason));
}

/**
 * What a failure is allowed to say to the user. The Record is exhaustive so a code added to the
 * union has to be given wording here rather than silently inheriting another failure's sentence.
 */
const FAILURE_MESSAGES = {
  aborted: 'The Cloudflare MCP operation was aborted.',
  authentication_failed: 'Cloudflare rejected the refreshed credential.',
  compatibility_drift: 'The official Cloudflare MCP tool contract is incompatible.',
  credential_unavailable: 'The Cloudflare credential is unavailable.',
  invalid_invocation: 'The Cloudflare MCP invocation is invalid.',
  malformed_response: 'Cloudflare returned a malformed MCP response.',
  provider_failure: 'Cloudflare could not complete the MCP operation.',
  redirect_rejected: 'The Cloudflare MCP endpoint attempted a redirect.',
  request_too_large: 'The Cloudflare MCP request exceeds its size limit.',
  response_too_large: 'The Cloudflare MCP response exceeds its size limit.',
  timeout: 'The Cloudflare MCP operation timed out.',
  transport_failure: 'The Cloudflare MCP transport failed.',
} satisfies Record<CloudflareMcpFailureCode, string>;

function safeFailureMessage(code: CloudflareMcpFailureCode): string {
  return FAILURE_MESSAGES[code];
}

async function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const code = timeoutErrorSchema.safeParse(signal.reason).success ? 'timeout' : 'aborted';
    throw new CloudflareMcpError(code, safeFailureMessage(code));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const code = timeoutErrorSchema.safeParse(signal.reason).success ? 'timeout' : 'aborted';
      reject(new CloudflareMcpError(code, safeFailureMessage(code)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}
