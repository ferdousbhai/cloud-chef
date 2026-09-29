import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCloudflareProject,
  renderCloudflareConfigFile,
} from "./lib/cloudflare-project-files.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { project, errors } = readCloudflareProject(rootDir);
if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
renderCloudflareConfigFile(rootDir, project);
