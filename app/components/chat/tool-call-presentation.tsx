import type { ReactNode } from 'react';
import { CheckIcon, CircleIcon, Cross2Icon, FileIcon, MagnifyingGlassIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { Spinner } from '@ui/Spinner';
import { isToolActivityStatusActive, type ToolActivityStatus } from '~/lib/common/types';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { getRelativePath } from 'cloudchef-agent/utils/workDir';
import { WORK_DIR } from 'cloudchef-agent/constants';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'cloudchef-agent/model-tool-inputs';
import { formatStreamedSize, streamedToolInput } from './streaming-tool-input';
import { z } from 'zod';
import { cloudflareApiRequestDisplaySchema, cloudflareApiRequestIsRead } from 'cloudchef-agent/cloudflare-api';
import { isCloudChefToolResult, toolResultSucceeded } from 'cloudchef-agent/tool-result';
import type { LinkedPublishView } from '~/lib/common/linked-publish';
import { validationFailed } from './validation-verdict';

const MAX_TOOL_TITLE_VALUE_CHARACTERS = 160;
/** Keyed by the model-facing tool name, which arrives as an unconstrained string on the invocation. */
const STOPPED_TOOL_TITLES = new Map<string, string>([
  ['read', 'File read stopped'],
  ['ls', 'File listing stopped'],
  ['grep', 'File search stopped'],
  ['write', 'File write stopped'],
  ['edit', 'File edit stopped'],
  ['exec', 'Command stopped'],
  ['validate', 'Checks stopped'],
  ['search_cloudflare_docs', 'Cloudflare docs search stopped'],
  ['cloudflare_request', 'Cloudflare API request stopped'],
  ['publish_preview', 'Preview stopped'],
  ['publish', 'Publishing stopped'],
  ['commit', 'Saving stopped'],
  ['fetch_site', 'Site read stopped'],
  ['history', 'History search stopped'],
]);

const cloudflareRequestMethodSchema = cloudflareApiRequestDisplaySchema.pick({ method: true });

/** A team project's publish that was not sent, or whose build failed or hit a conflict. */
function publishFailed(publish: LinkedPublishView): boolean {
  return publish.kind === 'not_sent' || publish.kind === 'failed' || publish.kind === 'conflict';
}

/**
 * `publish` is the view of a GitHub publish as of now (see useLinkedPublishView), or null for any other
 * call. A publish whose pipeline is still building shows its spinner in the title, never a check beside it.
 */
export function statusIcon(
  status: ToolActivityStatus,
  invocation: CloudChefToolInvocation,
  publish: LinkedPublishView | null,
): ReactNode {
  if (publish && status === 'complete') {
    if (publish.building) {
      return null;
    }
    return publishFailed(publish)
      ? icon(<Cross2Icon />, 'text-bolt-elements-icon-error')
      : icon(<CheckIcon />, 'text-bolt-elements-icon-success');
  }
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

export function toolTitle(
  invocation: CloudChefToolInvocation,
  status: ToolActivityStatus,
  publish: LinkedPublishView | null,
): ReactNode {
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
            ? 'Running a command'
            : 'Ran a command',
        <FileIcon />,
      );
    }
    case 'validate':
      return isToolActivityStatusActive(status)
        ? titleRow('Checking the project')
        : validationFailed(invocation)
          ? titleRow('Checks failed', <Cross2Icon className="text-content-secondary" />)
          : titleRow('Checked the project', <CheckIcon className="text-content-secondary" />);
    case 'commit':
      return isToolActivityStatusActive(status)
        ? titleRow('Saving a version')
        : isErrorResult(invocation)
          ? titleRow('Version not saved', <Cross2Icon className="text-content-secondary" />)
          : titleRow(
              alreadySaved(invocation) ? 'Already saved' : 'Saved a version',
              <CheckIcon className="text-content-secondary" />,
            );
    case 'search_cloudflare_docs':
      return titleRow(
        status === 'running' ? 'Searching Cloudflare docs' : 'Searched Cloudflare docs',
        <MagnifyingGlassIcon className="text-content-secondary" />,
      );
    case 'cloudflare_request': {
      const request = cloudflareRequestMethodSchema.safeParse(invocation.input).data;
      return request && cloudflareApiRequestIsRead(request)
        ? titleRow(
            status === 'running' ? 'Reading Cloudflare account' : 'Read Cloudflare account',
            <MagnifyingGlassIcon className="text-content-secondary" />,
          )
        : titleRow(
            status === 'running' ? 'Preparing Cloudflare change' : 'Cloudflare change proposal',
            <Pencil1Icon className="text-content-secondary" />,
          );
    }
    case 'publish_preview':
    case 'publish':
      if (publish) {
        return titleRow(
          publish.title,
          publish.building ? (
            <Spinner />
          ) : publishFailed(publish) ? (
            <Cross2Icon className="text-content-secondary" />
          ) : (
            <CheckIcon className="text-content-secondary" />
          ),
        );
      }
      return titleRow(
        invocation.toolName === 'publish' ? 'Publishing' : 'Making a preview',
        <Pencil1Icon className="text-content-secondary" />,
      );
    case 'history':
      return historyTitle(invocation, status);
    case 'fetch_site': {
      const args = MODEL_TOOL_INPUT_SCHEMAS.fetch_site.safeParse(invocation.input);
      const address = args.success ? siteAddressLabel(args.data.url) : 'the live site';
      return titleRow(
        `${status === 'running' ? 'Reading' : 'Read'} ${compactToolLabel(address)}`,
        <MagnifyingGlassIcon className="text-content-secondary" />,
      );
    }
    default:
      return invocation.toolName;
  }
}

const editedPathSchema = z.looseObject({ path: z.string() });
const historyInputSchema = z.looseObject({ op: z.string(), query: z.string().optional() });

function historyTitle(invocation: CloudChefToolInvocation, status: ToolActivityStatus): ReactNode {
  const input = historyInputSchema.safeParse(invocation.input).data;
  const running = status === 'running';
  const title =
    input?.op === 'search' && input.query
      ? `${running ? 'Searching' : 'Searched'} the conversation for ${compactToolLabel(input.query)}`
      : input?.op === 'read'
        ? `${running ? 'Reading' : 'Read'} an earlier message`
        : `${running ? 'Searching' : 'Searched'} the conversation`;
  return titleRow(title, <MagnifyingGlassIcon className="text-content-secondary" />);
}

/** A site address as a person reads it: host and path, without the scheme. */
function siteAddressLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

function icon(content: ReactNode, color: string): ReactNode {
  return <div className={classNames('text-base', color)}>{content}</div>;
}

/** A save that found the project's latest version already holds these files, so nothing new was saved. */
function alreadySaved(invocation: CloudChefToolInvocation): boolean {
  return (
    invocation.state === 'output-available' &&
    isCloudChefToolResult(invocation.output) &&
    z.object({ unchanged: z.literal(true) }).safeParse(invocation.output.data).success
  );
}

export function isErrorResult(invocation: CloudChefToolInvocation): boolean {
  if (invocation.toolName === 'validate') {
    return validationFailed(invocation);
  }
  return (
    invocation.state === 'output-error' ||
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
  const renderedPath = args.success ? compactToolLabel(getRelativePath(args.data.path) || WORK_DIR) : 'a file';
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
  // Only the path: an edit stored by an earlier release has other fields beside it.
  const args = editedPathSchema.safeParse(invocation.input);
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
