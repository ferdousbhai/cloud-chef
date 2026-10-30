import { useStore } from '@nanostores/react';
import { Menu } from '@ui/Menu';
import {
  projectVisitorsStore,
  useProjectPresence,
  type ProjectVisitor,
} from '~/lib/cloudflare/project-presence.client';
import { useWorkspaceId } from '~/lib/stores/workspaceId';

/** Beyond this many faces the rest are counted; on a phone, where the project's name needs the room, beyond one. */
const MAX_FACES = 3;

/**
 * Beside the open project's name, who else has it open now: their faces, quietly, and nothing at all while nobody
 * else is here. Choosing them lists their names, and whose agent is working.
 */
export function ProjectPresence() {
  const workspaceId = useWorkspaceId();
  useProjectPresence(workspaceId);
  const visitors = useStore(projectVisitorsStore);
  return <VisitorFaces visitors={visitors} />;
}

export function VisitorFaces({ visitors }: { visitors: readonly ProjectVisitor[] }) {
  if (visitors.length === 0) {
    return null;
  }
  const shown = visitors.slice(0, MAX_FACES);
  const more = visitors.length - shown.length;
  return (
    <Menu
      align="start"
      buttonProps={{
        variant: 'subtle',
        size: 'xs',
        className: 'shrink-0 px-1!',
        title: hereSentence(visitors),
        children: (
          <span className="flex items-center -space-x-1">
            {shown.map((visitor, index) => (
              // Each face over the next, so a working dot at its edge stays in sight.
              <span
                key={visitor.id}
                className={index > 0 ? 'relative max-[479px]:hidden' : 'relative'}
                style={{ zIndex: shown.length - index }}
              >
                <Face visitor={visitor} />
              </span>
            ))}
            {visitors.length > 1 ? <MoreCount count={visitors.length - 1} className="min-[480px]:hidden" /> : null}
            {more > 0 ? <MoreCount count={more} className="max-[479px]:hidden" /> : null}
          </span>
        ),
      }}
    >
      <p className="px-3 pt-1.5 pb-1 text-xs text-content-tertiary">Here now</p>
      <ul className="grid gap-0.5 pb-1">
        {visitors.map((visitor) => (
          <li key={visitor.id} className="flex min-w-0 items-center gap-2.5 px-3 py-1.5 text-sm">
            <Face visitor={visitor} />
            <span className="min-w-0">
              <span className="block truncate font-medium text-content-primary">{visitor.name}</span>
              {visitor.working ? (
                <span className="block text-xs text-content-secondary">Working with CloudChef</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Menu>
  );
}

function MoreCount({ count, className }: { count: number; className: string }) {
  return (
    <span
      className={`relative flex size-6 items-center justify-center rounded-full bg-bolt-elements-background-depth-3 text-[10px] font-semibold text-content-secondary ring-2 ring-background-primary ${className}`}
    >
      +{count}
    </span>
  );
}

function Face({ visitor }: { visitor: ProjectVisitor }) {
  return (
    <span className="relative flex size-6 shrink-0">
      {visitor.image ? (
        <img
          src={visitor.image}
          alt=""
          referrerPolicy="no-referrer"
          className="size-6 rounded-full object-cover ring-2 ring-background-primary"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-full bg-bolt-elements-background-depth-3 text-[10px] font-semibold text-content-primary ring-2 ring-background-primary"
        >
          {initial(visitor.name)}
        </span>
      )}
      {visitor.working ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-accent-500 ring-2 ring-background-primary"
        />
      ) : null}
    </span>
  );
}

/** "Sara is here", "Sara and Ada are here", "Sara, Ada and 2 others are here"; with who is working. */
export function hereSentence(visitors: readonly ProjectVisitor[]): string {
  const names = visitors.map((visitor) => visitor.name);
  const people =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length === 3 ? 'other' : 'others'}`;
  const working = visitors.filter((visitor) => visitor.working).map((visitor) => visitor.name);
  const workingNote =
    working.length === 0
      ? ''
      : working.length === 1 && names.length === 1
        ? ', working with CloudChef'
        : `; ${working.join(' and ')} ${working.length === 1 ? 'is' : 'are'} working with CloudChef`;
  return `${people} ${names.length === 1 ? 'is' : 'are'} here${workingNote}`;
}

/** A name's first letter, which fits a face this small in the interface's fixed-width type. */
function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
