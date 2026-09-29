import { PLACEHOLDER_D1_DATABASE_ID } from "./lib/cloudflare-project.mjs";
import {
  readCloudflareProject,
  runCf,
} from "./lib/cloudflare-project-files.mjs";

const rootDir = process.cwd();
const { project, errors } = readCloudflareProject(rootDir);
if (errors.length > 0) {
  throw new Error(errors.join("\n"));
}

const databases = [
  project.d1 && { label: "DB", id: project.d1.id, dir: "migrations" },
  project.agent && {
    label: "AGENT_SECURITY_DB",
    id: project.agent.securityD1.id,
    dir: "agent-security-migrations",
  },
].filter(Boolean);

for (const database of databases) {
  if (database.id === PLACEHOLDER_D1_DATABASE_ID) {
    throw new Error(`${database.label} has no provisioned D1 database id.`);
  }
  const result = runCf(
    rootDir,
    ["d1", "migrations", "apply", database.id, "--dir", database.dir],
    "inherit",
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`D1 migration failed for ${database.label}.`);
  }
}
