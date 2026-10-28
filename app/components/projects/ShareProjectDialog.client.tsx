import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Modal } from '@ui/Modal';
import { Button } from '@ui/Button';
import { getJson, messageOf } from '~/lib/json-request';
import { projectRoleSchema } from '~/lib/cloudflare/org-projects.client';
import { FeedbackLine, errorFeedback, type Feedback } from '~/components/settings/Feedback';
import { ProjectAccessList, type ProjectGrant, type ProjectMember } from './ProjectAccessList.client';

/** The part of an admin's view of their teams that sharing one project needs. */
const teamsSchema = z.object({
  organizations: z.array(
    z.object({
      orgId: z.string(),
      members: z
        .array(
          z.object({
            userId: z.string(),
            name: z.string(),
            email: z.string(),
            role: z.enum(['admin', 'member']),
          }),
        )
        .nullable(),
      projects: z.array(
        z.object({
          id: z.string(),
          access: z.array(z.object({ userId: z.string(), role: projectRoleSchema })),
        }),
      ),
    }),
  ),
});

/** Who may view or edit a team project, reached from its card on the projects home. */
export function ShareProjectDialog({
  orgId,
  project,
  onClose,
}: {
  orgId: string;
  project: { id: string; name: string };
  onClose: () => void;
}) {
  const [team, setTeam] = useState<{ members: ProjectMember[]; access: ProjectGrant[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(
    () =>
      getJson('/api/organizations', teamsSchema).then(({ organizations }) => {
        const organization = organizations.find((candidate) => candidate.orgId === orgId);
        const shared = organization?.projects.find((candidate) => candidate.id === project.id);
        if (!organization?.members || !shared) {
          throw new Error('Only the team’s admins can share its projects.');
        }
        setTeam({ members: organization.members, access: shared.access });
      }),
    [orgId, project.id],
  );

  useEffect(() => {
    load().catch((error) => setLoadError(messageOf(error, 'Sharing could not be loaded.')));
  }, [load]);

  return (
    <Modal onClose={onClose} title="Share" description={project.name}>
      {loadError !== null ? (
        <div role="alert" className="grid gap-2 text-sm text-content-secondary">
          <p>{loadError}</p>
          <Button
            className="justify-self-start"
            size="xs"
            variant="neutral"
            onClick={() => {
              setLoadError(null);
              load().catch((error) => setLoadError(messageOf(error, 'Sharing could not be loaded.')));
            }}
          >
            Try again
          </Button>
        </div>
      ) : team === null ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading the team…
        </p>
      ) : (
        <>
          <ProjectAccessList
            orgId={orgId}
            project={project}
            members={team.members}
            access={team.access}
            onChanged={load}
            onError={(message) => setFeedback(errorFeedback(message))}
          />
          <FeedbackLine feedback={feedback} />
        </>
      )}
    </Modal>
  );
}
