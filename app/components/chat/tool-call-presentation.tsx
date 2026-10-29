import type { ReactNode } from 'react';
import { CheckIcon, CircleIcon, Cross2Icon, FileIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { Spinner } from '@ui/Spinner';
import { isToolActivityStatusActive, type ToolActivityStatus } from '~/lib/common/types';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { getRelativePath } from 'cloudchef-agent/utils/workDir';
import { WORK_DIR } from 'cloudchef-agent/constants';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'cloudchef-agent/model-tool-inputs';
import { VALIDATE_COMMAND } from 'cloudchef-agent/constants';
import { formatStreamedSize, streamedToolInput } from './streaming-tool-input';
import { z } from 'zod';
import { isCloudChefToolResult, toolResultSucceeded } from 'cloudchef-agent/tool-result';
import type { LinkedPublishView } from '~/lib/common/linked-publish';
import { attachedValidation, validationFailed } from './validation-verdict';

const MAX_TOOL_TITLE_VALUE_CHARACTERS = 160;
/** Keyed by the model-facing tool name, which arrives as an unconstrained string on the invocation. */
const STOPPED_TOOL_TITLES = new Map<string, string>([
  ['read', 'File read stopped'],
  ['write', 'File write stopped'],
  ['edit', 'File edit stopped'],
  ['exec', 'Command stopped'],
  ['publish_preview', 'Preview stopped'],
  ['publish', 'Publishing stopped'],
  ['commit', 'Saving stopped'],
]);

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
    case 'write':
      return writeTitle(invocation);
    case 'edit':
      return editTitle(invocation, status);
    case 'exec': {
      if (publish) {
        return publishTitle(publish);
      }
      const args = MODEL_TOOL_INPUT_SCHEMAS.exec.safeParse(invocation.input);
      if (args.data?.command.trim() === VALIDATE_COMMAND) {
        return validationTitle(invocation, status);
      }
      return titleRow(
        args.success
          ? `${status === 'running' ? 'Running' : 'Ran'} ${compactToolLabel(args.data.command)}`
          : status === 'running'
            ? 'Running a command'
            : 'Ran a command',
        <FileIcon />,
      );
    }
    case 'commit':
      return isToolActivityStatusActive(status)
        ? titleRow('Saving a version')
        : isErrorResult(invocation)
          ? titleRow('Version not saved', <Cross2Icon className="text-content-secondary" />)
          : titleRow(
              alreadySaved(invocation) ? 'Already saved' : 'Saved a version',
              <CheckIcon className="text-content-secondary" />,
            );
    case 'publish_preview':
    case 'publish':
      if (publish) {
        return publishTitle(publish);
      }
      return titleRow(
        invocation.toolName === 'publish' ? 'Publishing' : 'Making a preview',
        <Pencil1Icon className="text-content-secondary" />,
      );
    default:
      return invocation.toolName;
  }
}

/** The project's full checks, run as `cloudchef validate`. */
function validationTitle(invocation: CloudChefToolInvocation, status: ToolActivityStatus): ReactNode {
  return isToolActivityStatusActive(status)
    ? titleRow('Checking the project')
    : validationFailed(invocation)
      ? titleRow('Checks failed', <Cross2Icon className="text-content-secondary" />)
      : titleRow('Checked the project', <CheckIcon className="text-content-secondary" />);
}

/** A publish's title as its build stands: building, built, or failed. */
function publishTitle(publish: LinkedPublishView): ReactNode {
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

const editedPathSchema = z.looseObject({ path: z.string() });

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
  if (attachedValidation(invocation)) {
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
