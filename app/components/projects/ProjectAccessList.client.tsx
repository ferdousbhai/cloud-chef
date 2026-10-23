import { useState } from 'react';
import { noContentSchema, postJson, runRequest } from '~/lib/json-request';
import type { ProjectRole } from '~/lib/cloudflare/org-projects.client';

export type ProjectMember = { userId: string; name: string; email: string; role: 'admin' | 'member' };
export type ProjectGrant = { userId: string; role: ProjectRole };

type Choice = ProjectRole | 'none';

const CHOICES: { value: Choice; label: string }[] = [
  { value: 'none', label: 'No access' },
  { value: 'view', label: 'Can view' },
  { value: 'edit', label: 'Can edit' },
];

/**
 * Who may view or edit a team project, as an admin sets it: one choice per member. Admins own every project
 * and are listed as owners.
 */
export function ProjectAccessList({
  orgId,
  project,
  members,
  access,
  onChanged,
  onError,
}: {
  orgId: string;
  project: { id: string; name: string };
  members: ProjectMember[];
  access: ProjectGrant[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  // A choice being saved, shown as chosen until the refreshed list arrives.
  const [saving, setSaving] = useState<ReadonlyMap<string, Choice>>(new Map());
  const granted = new Map(access.map((grant) => [grant.userId, grant.role]));

  const choose = async (userId: string, choice: Choice) => {
    setSaving((current) => new Map(current).set(userId, choice));
    await runRequest(async () => {
      await postJson(
        '/api/organizations/projects/access',
        { orgId, projectId: project.id, userId, role: choice === 'none' ? null : choice },
        noContentSchema,
      );
      await onChanged();
    }, onError);
    setSaving((current) => {
      const next = new Map(current);
      next.delete(userId);
      return next;
    });
  };

  if (members.length === 0) {
    return <p className="text-xs text-content-tertiary">Invite people to the team to share this project.</p>;
  }

  return (
    <ul className="grid gap-1.5 text-sm" aria-label={`Who can use ${project.name}`}>
      {members.map((member) => {
        const label = member.name || member.email;
        return (
          <li key={member.userId} className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={member.email}>
              {label}
              {member.name ? <span className="text-content-tertiary"> {member.email}</span> : null}
            </span>
            {member.role === 'admin' ? (
              <span className="text-xs text-content-secondary">Owner</span>
            ) : (
              <select
                aria-label={`${label}'s access to ${project.name}`}
                value={saving.get(member.userId) ?? granted.get(member.userId) ?? 'none'}
                disabled={saving.has(member.userId)}
                onChange={(event) => {
                  const choice = CHOICES.find((candidate) => candidate.value === event.target.value);
                  if (choice) {
                    void choose(member.userId, choice.value);
                  }
                }}
                className="min-h-8 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 text-xs text-content-primary"
              >
                {CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            )}
          </li>
        );
      })}
    </ul>
  );
}
