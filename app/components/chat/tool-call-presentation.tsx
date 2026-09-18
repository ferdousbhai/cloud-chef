import type { ReactNode } from 'react';
import { CheckIcon, CircleIcon, Cross2Icon, FileIcon, MagnifyingGlassIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { Spinner } from '@ui/Spinner';
import type { ToolActivityStatus } from '~/lib/common/types';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { getRelativePath } from 'cloudchef-agent/utils/workDir';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'cloudchef-agent/model-tool-inputs';
import { formatStreamedSize, streamedToolInput } from './streaming-tool-input';
import type { ZodType } from 'zod';
import { toolFailure, toolResultSucceeded } from 'cloudchef-agent/tool-result';
import { AUTO_VALIDATION_TOOL_CALL_ID_PREFIX } from '~/lib/common/builder-validation-progress';

const MAX_TOOL_TITLE_VALUE_CHARACTERS = 160;
/** Keyed by the model-facing tool name, which arrives as an unconstrained string on the invocation. */
const STOPPED_TOOL_TITLES = new Map<string, string>([
  ['read', 'File read stopped'],
  ['ls', 'File listing stopped'],
  ['grep', 'File search stopped'],
  ['write', 'File write stopped'],
  ['edit', 'File edit stopped'],
  ['exec', 'Command stopped'],
  ['validate', 'Validation stopped'],
  ['search_cloudflare_docs', 'Cloudflare docs search stopped'],
  ['cloudflare_docs', 'Cloudflare MCP docs search stopped'],
  ['cloudflare_search', 'Cloudflare account search stopped'],
  ['cloudflare_execute', 'Cloudflare proposal stopped'],
]);

const MODEL_TOOL_INPUT_SCHEMA_BY_NAME = new Map<string, ZodType>(Object.entries(MODEL_TOOL_INPUT_SCHEMAS));

const emptyInvocation: CloudChefToolInvocation = {
  type: 'dynamic-tool',
  state: 'input-streaming',
  toolCallId: '',
  toolName: '',
  input: {},
};

export function normalizeToolInvocation(invocation: CloudChefToolInvocation | undefined): CloudChefToolInvocation {
  if (!invocation || invocation.state !== 'output-available' || isErrorResult(invocation)) {
    return invocation ?? emptyInvocation;
  }
  const schema = MODEL_TOOL_INPUT_SCHEMA_BY_NAME.get(invocation.toolName);
  const parsed = schema?.safeParse(invocation.input);
  return parsed?.success === false
    ? { ...invocation, output: toolFailure(`Could not parse arguments: ${parsed.error.message}`) }
    : invocation;
}

export function statusIcon(status: ToolActivityStatus, invocation: CloudChefToolInvocation): ReactNode {
  if (isErrorResult(invocation)) {
    return icon(<Cross2Icon />, 'text-bolt-elements-icon-error');
  }
  switch (status) {
    case 'running':
      return icon(<Spinner />, 'text-bolt-elements-loader-progress');
    case 'pending':
      return icon(<CircleIcon />, 'text-content-tertiary');
    case 'complete':
      return icon(<CheckIcon />, 'text-bolt-elements-icon-success');
    case 'aborted':
      return icon(<Cross2Icon />, 'text-content-secondary');
  }
  return null;
}

export function toolTitle(invocation: CloudChefToolInvocation, status: ToolActivityStatus): ReactNode {
  if (status === 'aborted') {
    return STOPPED_TOOL_TITLES.get(invocation.toolName) ?? 'Tool stopped';
  }
  switch (invocation.toolName) {
    case 'read':
      return readTitle(invocation, status);
    case 'ls':
      return listTitle(invocation, status);
    case 'grep':
      return searchTitle(invocation, status);
    case 'write':
      return writeTitle(invocation);
    case 'edit':
      return editTitle(invocation, status);
    case 'exec': {
      const args = MODEL_TOOL_INPUT_SCHEMAS.exec.safeParse(invocation.input);
      return titleRow(
        args.success
          ? `${status === 'running' ? 'Running' : 'Ran'} ${compactToolLabel(args.data.command)}`
          : status === 'running'
            ? 'Running a workspace command'
            : 'Ran a workspace command',
        <FileIcon />,
      );
    }
    case 'validate': {
      // The builder runs the canonical validation itself when a turn ends unvalidated. Saying so
      // keeps the model's own validate calls distinguishable from the ones the server owes the user.
      const automatic = invocation.toolCallId.startsWith(AUTO_VALIDATION_TOOL_CALL_ID_PREFIX);
      return titleRow(
        status === 'running'
          ? automatic
            ? 'Validating the project (automatic)…'
            : 'Validating the project'
          : automatic
            ? 'Validated the project (automatic)'
            : 'Validated the project',
        <CheckIcon className="text-content-secondary" />,
      );
    }
    case 'search_cloudflare_docs':
      return titleRow(
        status === 'running' ? 'Searching Cloudflare docs' : 'Searched Cloudflare docs',
        <MagnifyingGlassIcon className="text-content-secondary" />,
      );
    case 'cloudflare_docs':
      return titleRow(
        status === 'running' ? 'Searching Cloudflare MCP docs' : 'Searched Cloudflare MCP docs',
        <MagnifyingGlassIcon className="text-content-secondary" />,
      );
    case 'cloudflare_search':
      return titleRow(
        status === 'running' ? 'Searching Cloudflare account' : 'Searched Cloudflare account',
        <MagnifyingGlassIcon className="text-content-secondary" />,
      );
    case 'cloudflare_execute':
      return titleRow(
        status === 'running' ? 'Preparing Cloudflare proposal' : 'Cloudflare execution proposal',
        <Pencil1Icon className="text-content-secondary" />,
      );
    default:
      return invocation.toolName;
  }
}

function icon(content: ReactNode, color: string): ReactNode {
  return <div className={classNames('text-base', color)}>{content}</div>;
}

function isErrorResult(invocation: CloudChefToolInvocation): boolean {
  return (
    invocation.state === 'output-error' ||
    invocation.state === 'output-denied' ||
    (invocation.state === 'output-available' && !toolResultSucceeded(invocation.output))
  );
}

function titleRow(children: ReactNode, iconContent?: ReactNode): ReactNode {
  return (
    <div className="flex items-center gap-1.5">
      {iconContent}
      <span className="truncate">{children}</span>
    </div>
  );
}

/**
 * The model writes a tool's arguments a token at a time, so the file it is about to touch is
 * knowable — and worth showing — long before the call is complete. Until the path is legible the
 * title stays with the wording it has always used.
 */
function streamingFileTitle(invocation: CloudChefToolInvocation, verb: string, fallback: string): string {
  const streamed = streamedToolInput(invocation);
  if (streamed.path === null) {
    return fallback;
  }
  const written = streamed.characters > 0 ? ` ${formatStreamedSize(streamed.characters)}` : '';
  return `${verb} ${compactToolLabel(getRelativePath(streamed.path) || streamed.path)}…${written}`;
}

function isStreamingInput(invocation: CloudChefToolInvocation): boolean {
  return invocation.state === 'input-streaming';
}

function readTitle(invocation: CloudChefToolInvocation, status: ToolActivityStatus): ReactNode {
  if (isStreamingInput(invocation)) {
    return titleRow(
      streamingFileTitle(invocation, 'Reading', 'Reading a file…'),
      <FileIcon className="text-content-secondary" />,
    );
  }
  const args = MODEL_TOOL_INPUT_SCHEMAS.read.safeParse(invocation.input);
  const renderedPath = args.success ? compactToolLabel(getRelativePath(args.data.path) || '/home/project') : 'a file';
  const extra = args.success && args.data.offset ? ` (from line ${args.data.offset})` : '';
  return titleRow(
    `${status === 'running' ? 'Reading' : 'Read'} ${renderedPath}${extra}`,
    <FileIcon className="text-content-secondary" />,
  );
}

function listTitle(invocation: CloudChefToolInvocation, status: ToolActivityStatus): ReactNode {
  const args = MODEL_TOOL_INPUT_SCHEMAS.ls.safeParse(invocation.input);
  const target = args.success && args.data.path ? getRelativePath(args.data.path) || args.data.path : 'the project';
  return titleRow(
    `${status === 'running' ? 'Listing' : 'Listed'} ${compactToolLabel(target)}`,
    <FileIcon className="text-content-secondary" />,
  );
}

function searchTitle(invocation: CloudChefToolInvocation, status: ToolActivityStatus): ReactNode {
  const args = MODEL_TOOL_INPUT_SCHEMAS.grep.safeParse(invocation.input);
  return titleRow(
    args.success
      ? `${status === 'running' ? 'Searching' : 'Searched'} for ${compactToolLabel(args.data.pattern)}`
      : `${status === 'running' ? 'Searching' : 'Searched'} the project`,
    <MagnifyingGlassIcon className="text-content-secondary" />,
  );
}

function editTitle(invocation: CloudChefToolInvocation, status: ToolActivityStatus): ReactNode {
  if (isStreamingInput(invocation)) {
    return titleRow(
      streamingFileTitle(invocation, 'Editing', 'Editing a file…'),
      <Pencil1Icon className="text-content-secondary" />,
    );
  }
  const args = MODEL_TOOL_INPUT_SCHEMAS.edit.safeParse(invocation.input);
  return titleRow(
    `${status === 'running' ? 'Editing' : 'Edited'} ${args.success ? compactToolLabel(getRelativePath(args.data.path) || args.data.path) : 'a file'}`,
    <Pencil1Icon className="text-content-secondary" />,
  );
}

function writeTitle(invocation: CloudChefToolInvocation): ReactNode {
  if (isStreamingInput(invocation)) {
    return titleRow(
      streamingFileTitle(invocation, 'Writing', 'Writing a file…'),
      <FileIcon className="text-content-secondary" />,
    );
  }
  if (isToolInvocationInProgress(invocation)) {
    const args = MODEL_TOOL_INPUT_SCHEMAS.write.safeParse(invocation.input);
    return titleRow(
      args.success
        ? `Writing ${compactToolLabel(getRelativePath(args.data.path) || args.data.path)}…`
        : 'Writing a file…',
      <FileIcon className="text-content-secondary" />,
    );
  }
  const args = MODEL_TOOL_INPUT_SCHEMAS.write.safeParse(invocation.input);
  return titleRow(
    `Wrote ${args.success ? compactToolLabel(getRelativePath(args.data.path) || args.data.path) : 'a file'}`,
    <FileIcon className="text-content-secondary" />,
  );
}

function compactToolLabel(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= MAX_TOOL_TITLE_VALUE_CHARACTERS
    ? singleLine
    : `${singleLine.slice(0, MAX_TOOL_TITLE_VALUE_CHARACTERS - 1)}…`;
}
