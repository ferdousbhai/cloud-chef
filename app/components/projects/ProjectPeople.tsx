import { Avatar } from '~/components/showcase/Avatar';
import type { ProjectPerson } from '~/lib/cloudflare/org-projects.client';

/** How many faces a card shows before the rest are counted. */
const FACES_SHOWN = 4;

/**
 * Who else is on a project, at a glance: their faces, whoever runs it first, overlapping as a shared document shows
 * them. Never the person looking, who knows they are on it: so a project only they are on shows none, their own
 * shared project shows who they shared it with, and one shared with them shows whose it is. Each face names the
 * person and what they may do when pointed at; whoever runs the project opens its sharing from them.
 */
export function ProjectPeople({
  project,
  people,
  onManage,
}: {
  project: string;
  /** Everyone on it but the person looking. */
  people: readonly ProjectPerson[];
  /** Opens the project's sharing; left out for someone who doesn't run it. */
  onManage?: () => void;
}) {
  if (people.length === 0) {
    return null;
  }
  const shown = people.slice(0, FACES_SHOWN);
  const more = people.length - shown.length;
  const named = people.map((person) => `${person.name} (${roleWords(person.role)})`).join(', ');
  const faces = (
    <span className="flex items-center">
      {shown.map((person, index) => (
        <span
          key={person.userId}
          title={`${person.name} · ${roleWords(person.role)}`}
          className={`rounded-full ring-2 ring-bolt-elements-background-depth-1 ${index > 0 ? '-ml-1' : ''}`}
        >
          <Avatar name={person.name} image={person.image} size={24} />
        </span>
      ))}
      {more > 0 ? (
        <span
          title={people
            .slice(FACES_SHOWN)
            .map((person) => person.name)
            .join(', ')}
          className="-ml-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-bolt-elements-background-depth-3 px-1 text-[11px] font-medium text-content-secondary ring-2 ring-bolt-elements-background-depth-1"
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
  return onManage ? (
    <button
      type="button"
      onClick={onManage}
      aria-label={`Also on ${project}: ${named}. Change who it is shared with`}
      className="ml-auto shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {faces}
    </button>
  ) : (
    <span role="img" aria-label={`Also on ${project}: ${named}`} className="ml-auto shrink-0">
      {faces}
    </span>
  );
}

function roleWords(role: ProjectPerson['role']): string {
  return role === 'owner' ? 'owner' : role === 'edit' ? 'can edit' : 'can view';
}
