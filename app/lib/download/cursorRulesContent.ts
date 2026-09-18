import projectStackSkill from '~/lib/guidance/project-stack/SKILL.md?raw';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';

/* The builder reads the same skill in every workspace; only the frontmatter is skill-specific. */
const stackSelectionRules = projectStackSkill.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();

export const cursorRulesContent = `# CloudChef Cloudflare App Rules

${stackSelectionRules}
- Keep pnpm run dev and pnpm run preview available for local and isolated remote preview.
- After changing production dependencies, run pnpm run licenses:generate before build or deploy so the shipped third-party notices match the lockfile.
- Keep the default Worker entrypoint in src/plain-server.ts. Run pnpm run agent:enable only when the application actually needs durable Agent sessions or Workers AI; that command switches to the protected src/server.ts entrypoint and enables the capability atomically.
- In generated TanStack routes and server functions, call getAppBindings() from @/app-bindings for application DB/R2 access.
- Do not import cloudflare:workers from generated source. AI, AppAgent, and AGENT_SECURITY_DB bindings are intentionally unavailable to generated routes.
- When the AppAgent capability is enabled, automatically deployed projects do not allow dynamic import(), require(), eval(), or Function constructors in generated source.
- When AI is needed, use Workers AI only through the reviewed AppAgent and prefer ${CLOUDFLARE_WORKERS_AI_MODEL} for coding-agent features.
- For a durable AI feature, enable the protected Cloudflare Agents capability instead of assembling bindings and security state by hand. For chat UI, prefer the template AIChatAgent with useAgentChat from @cloudflare/ai-chat/react.
- Set static override options = { sendIdentityOnConnect: false } when Agent instance names can contain chat IDs, user IDs, or session IDs, and use state updates rather than agent.identified for readiness.
- Treat client-supplied Agent instance names as routing hints, not authorization. Before public production use, authenticate and rate-limit Agent routes and derive tenant or user instance names from verified server-side identity.
- Keep Agent chat behavior explicit with messageConcurrency = "queue", chatRecovery, and options?.abortSignal passed through to streamText. Configure waitForMcpConnections when the Agent uses MCP servers.
- For production Agent observability, use Agents diagnostics-channel events and attach a Cloudflare Tail Worker when structured Agent RPC, chat, recovery, state, schedule, workflow, or MCP events need collection.
- Update wrangler.jsonc when adding bindings, Durable Object exports, D1 migrations, D1, R2, KV, Queues, or Vectorize. Use declarative exports with SQLite storage for new Durable Object classes.
- Keep wrangler.jsonc production observability explicit: observability.enabled, observability.logs.enabled, and observability.traces.enabled should be true, with logs head_sampling_rate 0.6 and traces head_sampling_rate 0.05 unless production volume requires different sampling.
- Keep secret values out of project files. For an app-specific credential, declare its name with secrets.required and configure a per-Worker secret with wrangler secret put NAME or the Worker's dashboard settings. For a credential intentionally reused across Workers or AI Gateway, an exported project can bind an existing account secret with secrets_store_secrets; Worker access requires workers scope and reads it asynchronously with await env.BINDING.get(), while AI Gateway uses ai-gateway scope. Deploying the Worker binding requires Account Secrets Store Edit permission or an equivalent role. CloudChef managed deployment does not currently support Secrets Store bindings.
- Keep CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN as production deploy credentials only; do not use them as Worker runtime secrets.
- Keep backend code on Cloudflare Workers and Cloudflare developer platform primitives.
- Validate changes with pnpm run verify:stack, pnpm run typecheck, pnpm run build, and pnpm run lint.
- Deploy directly to the production Cloudflare Worker with pnpm run deploy. Do not add staging targets or local dev-server deployment paths.
`;
