import { z } from 'zod';
import type { CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { isCloudChefToolResult, toolResultSucceeded, type CloudChefToolResult } from 'cloudchef-agent/tool-result';

const validationAttachmentSchema = z.looseObject({ validation: z.unknown().optional() });

/**
 * The validation a finished tool call carries in `validation`: `validate` returns `{ validation }`, as
 * does an `exec` that runs the full validation command.
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
