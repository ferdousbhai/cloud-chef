// Generated from cloudflare.project.json by scripts/render-cloudflare-config.mjs. Do not edit.
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "cloudchef-cloudflare-app",
    compatibilityDate: "2026-07-21",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/plain-server.ts",
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 0.6 },
      traces: { enabled: true, headSamplingRate: 0.05 },
    },
    env: {
      DB: bindings.d1({ name: "cloudchef-cloudflare-app", id: "00000000-0000-0000-0000-000000000000" }),
      APP_CACHE: bindings.kv({ id: "00000000000000000000000000000000" }),
      APP_STORAGE: bindings.r2({ name: "cloudchef-cloudflare-app-storage" }),
    },
  },
});
