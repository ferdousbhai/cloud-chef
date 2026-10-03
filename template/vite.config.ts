import { defineConfig, type PluginOption } from "vite";
import { readFileSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.resolve(projectDir, "package.json"), "utf8"),
);
const agentCapabilityEnabled = Object.hasOwn(
  packageJson.dependencies ?? {},
  "agents",
);
const agentsViteModule = "agents/vite";
const baseAlias = {
  "@": path.resolve(projectDir, "./src"),
  "#": path.resolve(projectDir, "./src"),
};

/**
 * Add framework plugins (React, TanStack Start, React Router, ...) to `frameworkPlugins`; keep the
 * module-security plugin first and the Cloudflare plugin last.
 */
async function productionPlugins(): Promise<PluginOption[]> {
  const [{ cloudflare }, { productionModuleSecurityPlugin }] =
    await Promise.all([
      import("@cloudflare/vite-plugin"),
      import("./scripts/lib/runtime-module-security.ts"),
    ]);
  const agentPlugins: PluginOption[] = [];
  if (agentCapabilityEnabled) {
    const { default: agents } = await import(agentsViteModule);
    agentPlugins.push(agents());
  }
  const frameworkPlugins: PluginOption[] = [];
  return [
    productionModuleSecurityPlugin(projectDir),
    ...agentPlugins,
    ...frameworkPlugins,
    cloudflare({
      // Runtime types come from @cloudflare/workers-types; generating them would start workerd.
      types: { includeRuntime: false },
    }),
  ];
}

export default defineConfig(async () => ({
  plugins: await productionPlugins(),
  resolve: {
    alias: baseAlias,
  },
}));
