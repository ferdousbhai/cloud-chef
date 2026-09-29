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
async function productionPlugins(): Promise<PluginOption[]> {
  const [
    { tanstackStart },
    { cloudflare },
    { default: react },
    { productionModuleSecurityPlugin },
  ] = await Promise.all([
    import("@tanstack/react-start/plugin/vite"),
    import("@cloudflare/vite-plugin"),
    import("@vitejs/plugin-react"),
    import("./scripts/lib/runtime-module-security.ts"),
  ]);
  const agentPlugins: PluginOption[] = [];
  if (agentCapabilityEnabled) {
    const { default: agents } = await import(agentsViteModule);
    agentPlugins.push(agents());
  }
  return [
    productionModuleSecurityPlugin(projectDir),
    ...agentPlugins,
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // Runtime types come from @cloudflare/workers-types; generating them would start workerd.
      types: { includeRuntime: false },
    }),
    tanstackStart(),
    react(),
  ];
}

export default defineConfig(async () => ({
  plugins: await productionPlugins(),
  resolve: {
    alias: baseAlias,
  },
}));
