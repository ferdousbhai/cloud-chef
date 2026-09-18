export const CLIENT_TELEMETRY_EVENTS = [
  'Builder connection was not ready before send',
  'Failed to enhance prompt',
  'Failed to process chat request',
  'Failed to start Cloudflare authorization',
  'Failed to submit chat message',
  'Unknown assistant message part',
  'User tried to send message but CloudChef is too busy',
] as const;

export type ClientTelemetryEvent = (typeof CLIENT_TELEMETRY_EVENTS)[number];

export const PRODUCT_TELEMETRY_EVENTS = [
  'landing_viewed',
  'cloudflare_connect_started',
  'prompt_submitted',
  'first_tool_completed',
  'validation_succeeded',
  'preview_ready',
  'deployment_succeeded',
] as const;

export type ProductTelemetryEvent = (typeof PRODUCT_TELEMETRY_EVENTS)[number];
export const ALL_CLIENT_TELEMETRY_EVENTS = [...CLIENT_TELEMETRY_EVENTS, ...PRODUCT_TELEMETRY_EVENTS] as const;
