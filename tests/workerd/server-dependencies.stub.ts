const unavailable = () => new Response('Unavailable in the workerd route integration suite', { status: 503 });

export default { fetch: unavailable };

export const CLOUDFLARE_CONNECTION_CALLBACK_METHOD = 'GET' as const;
export const authSessionAction = unavailable;
export const cloudflareConnectionStatusAction = unavailable;
export const cloudflareRuntimeSessionAction = unavailable;
export const completeCloudflareConnectionAction = unavailable;
export const pruneCloudflareAuthDataBestEffort = async () => undefined;
export const signOutAction = unavailable;
export const startCloudflareConnectionAction = unavailable;
