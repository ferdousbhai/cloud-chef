import { getAgentByName } from "agents";
import application from "./application";
import { finalizeApplicationResponse } from "./application-response";
import { routeAppAgentRequest, type AppAgentResolver } from "./agent-routing";
import { cleanupExpiredAgentSecurityState } from "./agent-security";

export { AppAgent } from "./agents/app-agent";

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAppAgentRequest(
      request,
      env,
      getAgentByName as unknown as AppAgentResolver,
    );
    return finalizeApplicationResponse(request, agentResponse, () =>
      application.fetch(request, env),
    );
  },
  async scheduled(controller: ScheduledController, env: Env) {
    await cleanupExpiredAgentSecurityState(
      env.AGENT_SECURITY_DB,
      controller.scheduledTime,
    );
  },
} satisfies ExportedHandler<Env>;
