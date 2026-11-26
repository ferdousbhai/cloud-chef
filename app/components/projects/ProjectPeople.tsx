import { Avatar } from '~/components/showcase/Avatar';
import type { ProjectPerson } from '~/lib/cloudflare/org-projects.client';

/** How many faces a card shows before the rest are counted. */
const FACES_SHOWN = 4;

/**
 * Who is on a project, at a glance: their faces, whoever runs it first, overlapping as a shared document shows them.
 * A project only its owner is on shows none, so a face on a card always means someone else is there. Each face names
 * the person and what they may do when pointed at; whoever runs the project opens its sharing from them.
 */
export function ProjectPeople({
  project,
  people,
  onManage,
}: {
  project: string;
  people: readonly ProjectPerson[];
  /** Opens the project's sharing; left out for someone who doesn't run it. */
  onManage?: () => void;
}) {
  if (people.length < 2) {
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
          className={`rounded-full ring-2 ring-bolt-elements-background-depth-1 ${index > 0 ? '-ml-1.5' : ''}`}
        >
          <Avatar name={person.name} image={person.image} size={22} />
        </span>
      ))}
      {more > 0 ? (
        <span
          title={people
            .slice(FACES_SHOWN)
            .map((person) => person.name)
            .join(', ')}
          className="-ml-1.5 flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-bolt-elements-background-depth-3 px-1 text-[11px] font-medium text-content-secondary ring-2 ring-bolt-elements-background-depth-1"
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
      aria-label={`On ${project}: ${named}. Change who it is shared with`}
      className="ml-auto shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {faces}
    </button>
  ) : (
    <span role="img" aria-label={`On ${project}: ${named}`} className="ml-auto shrink-0">
      {faces}
    </span>
  );
}

function roleWords(role: ProjectPerson['role']): string {
  return role === 'owner' ? 'owner' : role === 'edit' ? 'can edit' : 'can view';
}
