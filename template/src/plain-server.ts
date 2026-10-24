import application from "./application";
import { finalizeApplicationResponse } from "./application-response";

export default {
  fetch(request: Request, env: Env) {
    return finalizeApplicationResponse(null, () =>
      application.fetch(request, env),
    );
  },
} satisfies ExportedHandler<Env>;
