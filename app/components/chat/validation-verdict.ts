import { z } from 'zod';
import type { CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { isCloudChefToolResult, toolResultSucceeded, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { VALIDATE_COMMAND } from 'cloudchef-agent/constants';

const validationAttachmentSchema = z.looseObject({ validation: z.unknown().optional() });

const commandInputSchema = z.looseObject({ command: z.string() });

/**
 * The validation a finished tool call carries in `validation`: an `exec` that runs the full validation command
 * (`cloudchef validate`) returns `{ command, validation }`, as the `validate` tool of earlier conversations did.
 */
export function attachedValidation(invocation: CloudChefToolInvocation): CloudChefToolResult | null {
  if (invocation.state !== 'output-available') {
    return null;
  }
  const attached = validationAttachmentSchema.safeParse(invocation.output).data?.validation;
  return isCloudChefToolResult(attached) ? attached : null;
}

/** A validation's verdict rides in `validation`; the tool call itself succeeds either way. */
export function validationFailed(invocation: CloudChefToolInvocation): boolean {
  if (invocation.state === 'output-error') {
    return true;
  }
  if (invocation.state !== 'output-available') {
    return false;
  }
  const attached = attachedValidation(invocation);
  return attached ? !attached.ok : !toolResultSucceeded(invocation.output);
}

/** Whether the call runs the project's full validation, finished or not. */
export function isValidationCall(invocation: CloudChefToolInvocation): boolean {
  return (
    attachedValidation(invocation) !== null ||
    (invocation.toolName === 'exec' &&
      commandInputSchema.safeParse(invocation.input).data?.command.trim() === VALIDATE_COMMAND)
  );
}
