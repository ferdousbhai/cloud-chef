/**
 * WebMCP (https://webmachinelearning.github.io/webmcp/): tools this page offers an AI agent running in the
 * person's browser, so it can do a few things in CloudChef for them. Each tool calls what the page's own
 * buttons call, with the signed-in person's session, so it may do only what they may. None deletes,
 * publishes, approves or sends a message: starting a project fills in the message box, and the person sends it.
 *
 * The API is a draft: the current one is `document.modelContext.registerTool(tool, { signal })`, aborting
 * the signal to unregister; Chrome's early preview had it on `navigator.modelContext`, unregistering by name.
 * Both are used where present, and nothing happens in a browser with neither.
 */
import { useEffect } from 'react';
import { z } from 'zod';
import { loadApprovals } from './cloudflare/approvals.client';
import { loadPublicProjects, loadTeamProjects, openTeamProject } from './cloudflare/org-projects.client';
import { loadProjectDeployLog } from './cloudflare/projects.client';
import { leavePage } from './hooks/useUnsavedEditsGuard';
import { messageOf } from './json-request';

type ToolResult = WebMcpToolResult;

/** The page's model context (see types/webmcp.d.ts), or null in a browser without WebMCP. */
function findModelContext(): WebMcpModelContext | null {
  const context = document.modelContext ?? navigator.modelContext;
  return context?.registerTool ? context : null;
}

/** Registers `tools`, and answers how to take them away again. A tool the browser refuses is left out. */
function registerTools(context: WebMcpModelContext, tools: readonly WebMcpTool[]): () => void {
  const controller = new AbortController();
  for (const tool of tools) {
    try {
      Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch(() => undefined);
    } catch {
      // Already registered by another copy of this page's code, or refused: the agent goes without it.
    }
  }
  return () => {
    controller.abort();
    for (const tool of tools) {
      try {
        context.unregisterTool?.(tool.name);
      } catch {
        // The abort above already took it away.
      }
    }
  };
}

/** What the session says about the person, for the tools' answers and what they may do. */
type WebMcpPerson = {
  /** The account they work in now: Personal, or the team's name. */
  account: string;
  /** Whether they may start projects of their own here (a team can limit members to its projects). */
  mayStartProjects: boolean;
};

const MAX_LOG_CHARACTERS = 20_000;

function text(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }] };
}

function json(value: WebMcpJson): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

function refusal(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function tool<Input extends z.ZodType>(definition: {
  name: string;
  title: string;
  description: string;
  input: Input;
  readOnly: boolean;
  run: (input: z.infer<Input>) => Promise<ToolResult>;
}): WebMcpTool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input),
    annotations: { readOnlyHint: definition.readOnly },
    async execute(input: WebMcpToolInput) {
      const parsed = definition.input.safeParse(input ?? {});
      if (!parsed.success) {
        return refusal(`Invalid input: ${z.prettifyError(parsed.error)}`);
      }
      try {
        return await definition.run(parsed.data);
      } catch (cause) {
        return refusal(messageOf(cause, 'CloudChef could not do that. Try again.'));
      }
    },
  };
}

const projectIdInput = z.object({
  projectId: z.string().min(1).max(512).describe('A project id from list_projects.'),
});

/** The projects of the account the person works in now that they may view or edit, as the sidebar lists them. */
async function listProjects(person: WebMcpPerson) {
  return {
    account: person.account,
    projects: (await loadTeamProjects()).map((project) => ({
      projectId: project.id,
      name: project.name,
      address: project.fullName ?? null,
      role: project.role,
      visibility: project.visibility ?? null,
      site: project.siteUrl ?? null,
      latestPublish: project.deployment
        ? { state: project.deployment.state, reason: project.deployment.reason ?? null }
        : null,
      createdAt: project.createdAt ?? null,
    })),
  };
}

function cloudchefTools(person: WebMcpPerson): WebMcpTool[] {
  const tools: WebMcpTool[] = [
    tool({
      name: 'list_projects',
      title: 'List projects',
      description: `Lists the projects the signed-in person can open in their current CloudChef account (${person.account}): each one's id, name, address (OWNER/NAME, its git address is https://cloudchef.build/OWNER/NAME.git), the person's role (view or edit), its live site, and how its latest publish went.`,
      input: z.object({}),
      readOnly: true,
      run: async () => json(await listProjects(person)),
    }),
    tool({
      name: 'list_public_projects',
      title: 'List public projects',
      description:
        "Lists everyone's public CloudChef projects, newest first, as Explore shows them: name, address (OWNER/NAME), owner and live site.",
      input: z.object({}),
      readOnly: true,
      run: async () =>
        json(
          (await loadPublicProjects()).map((project) => ({
            name: project.name,
            address: project.fullName,
            owner: project.owner.username ?? project.owner.name,
            site: project.siteUrl,
            createdAt: project.createdAt,
            copiedFrom: project.copiedFrom?.fullName ?? null,
          })),
        ),
    }),
    tool({
      name: 'get_publish',
      title: 'Read a publish',
      description:
        "Reads how a project's newest publish to its live site went: queued, building, deploying, succeeded or failed, and why it failed. With includeLog, also the end of its log, to find what to fix. Projects published by Cloudflare Workers Builds have no log here.",
      input: projectIdInput.extend({
        includeLog: z.boolean().default(false).describe("Also return the end of the publish's log."),
      }),
      readOnly: true,
      run: async ({ projectId, includeLog }) => {
        const project = (await loadTeamProjects()).find((candidate) => candidate.id === projectId);
        if (!project) {
          return refusal('No project with that id is in this account. Use list_projects for the ids.');
        }
        const publish = project.deployment;
        if (!publish) {
          return json({ project: project.name, site: project.siteUrl ?? null, latestPublish: null });
        }
        return json({
          project: project.name,
          site: project.siteUrl ?? null,
          latestPublish: {
            state: publish.state,
            step: publish.step ?? null,
            failedAt: publish.failureStage ?? null,
            reason: publish.reason ?? null,
            updatedAt: new Date(publish.updatedAt).toISOString(),
          },
          log: includeLog ? (await loadProjectDeployLog(project.id, publish.id)).slice(-MAX_LOG_CHARACTERS) : null,
        });
      },
    }),
    tool({
      name: 'list_approvals',
      title: 'List approvals',
      description:
        'Lists what waits for the signed-in person as an admin of their teams: Cloudflare changes members asked for. Approving or declining is done by the person on the Approvals page.',
      input: z.object({}),
      readOnly: true,
      run: async () => {
        const approvals = await loadApprovals();
        if (!approvals.admin) {
          return json({ admin: false, note: 'The person is not an admin of any team, so nothing waits for them.' });
        }
        return json({
          waiting: approvals.waiting.map((approval) => ({
            team: approval.orgName,
            requester: approval.requester.name,
            change: `${approval.request.method} ${approval.request.url}`,
            warning: approval.warning,
            expiresAt: new Date(approval.expiresAt).toISOString(),
          })),
          page: `${window.location.origin}/approvals`,
        });
      },
    }),
    tool({
      name: 'open_project',
      title: 'Open a project',
      description:
        "Opens a project's workspace in this tab, where the person chats with CloudChef's agent about it. This page, and its tools, are replaced by the project's.",
      input: projectIdInput,
      readOnly: false,
      run: async ({ projectId }) => {
        const project = (await loadTeamProjects()).find((candidate) => candidate.id === projectId);
        if (!project) {
          return refusal('No project with that id is in this account. Use list_projects for the ids.');
        }
        const left = await openTeamProject(project);
        return text(left ? `Opening ${project.name}.` : 'The person chose to stay on this page.');
      },
    }),
  ];
  if (person.mayStartProjects) {
    tools.push(
      tool({
        name: 'start_project',
        title: 'Start a project',
        description:
          "Starts a new project from a description of what to make: CloudChef's home page opens in this tab with the description in its message box, and the person reviews it and sends it. Nothing is sent until they do.",
        input: z.object({
          prompt: z.string().trim().min(1).max(10_000).describe('What to make, in the words the person would use.'),
        }),
        readOnly: false,
        run: async ({ prompt }) => {
          const left = await leavePage(async () => {
            window.location.assign(`/?${new URLSearchParams({ prefill: prompt })}`);
          });
          return text(
            left
              ? 'The description is in the message box on the home page; the person sends it to start.'
              : 'The person chose to stay on this page.',
          );
        },
      }),
    );
  }
  return tools;
}

/** Offers CloudChef's tools to an in-browser agent while `person` is signed in, in a browser with WebMCP. */
export function useWebMcpTools(person: WebMcpPerson | null): void {
  const account = person?.account;
  const mayStartProjects = person?.mayStartProjects;
  useEffect(() => {
    const context = findModelContext();
    if (!context || account === undefined || mayStartProjects === undefined) {
      return undefined;
    }
    return registerTools(context, cloudchefTools({ account, mayStartProjects }));
  }, [account, mayStartProjects]);
}
