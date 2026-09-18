export type ToolResultCoverage = {
  complete: boolean;
  start: number;
  end: number;
  total: number;
  nextCursor?: string;
};

export type CloudChefToolResult<T = unknown> = {
  version: 1;
  ok: boolean;
  summary: string;
  data?: T;
  coverage?: ToolResultCoverage;
};

export function toolSuccess<T>(summary: string, data?: T, coverage?: ToolResultCoverage): CloudChefToolResult<T> {
  return toolResult(true, summary, data, coverage);
}

export function toolFailure<T>(summary: string, data?: T, coverage?: ToolResultCoverage): CloudChefToolResult<T> {
  return toolResult(false, summary, data, coverage);
}

function toolResult<T>(ok: boolean, summary: string, data?: T, coverage?: ToolResultCoverage): CloudChefToolResult<T> {
  const result: CloudChefToolResult<T> = { version: 1, ok, summary };
  if (data !== undefined) {
    result.data = data;
  }
  if (coverage) {
    result.coverage = coverage;
  }
  return result;
}

export function isCloudChefToolResult(value: unknown): value is CloudChefToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'ok' in value &&
    typeof value.ok === 'boolean' &&
    'summary' in value &&
    typeof value.summary === 'string'
  );
}

export function toolResultSummary(value: unknown): string {
  if (isCloudChefToolResult(value)) {
    return value.summary;
  }
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

export function toolResultSucceeded(value: unknown): boolean {
  if (isCloudChefToolResult(value)) {
    return value.ok;
  }
  if (typeof value === 'object' && value !== null) {
    if ('error' in value && typeof value.error === 'string') {
      return false;
    }
    if ('exitCode' in value && typeof value.exitCode === 'number') {
      return value.exitCode === 0;
    }
  }
  return true;
}
