import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Modal } from '@ui/Modal';
import { getJson } from '~/lib/json-request';
import { Avatar } from './Avatar';

const peopleSchema = z.object({
  people: z.array(z.object({ username: z.string(), name: z.string(), image: z.string().nullable() })),
});

/** Who follows the person, or whom they follow: lists only they see. */
export function FollowListDialog({ which, onClose }: { which: 'followers' | 'following'; onClose: () => void }) {
  const [people, setPeople] = useState<z.infer<typeof peopleSchema>['people'] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getJson(`/api/showcase/follows?which=${which}`, peopleSchema, undefined, controller.signal)
      .then((answer) => setPeople(answer.people))
      .catch(() => !controller.signal.aborted && setPeople([]));
    return () => controller.abort();
  }, [which]);
  return (
    <Modal
      onClose={onClose}
      title={which === 'followers' ? 'Followers' : 'Following'}
      description="Only you can see this list."
    >
      {people === null ? (
        <p className="text-sm text-content-tertiary" role="status">
          Loading…
        </p>
      ) : people.length === 0 ? (
        <p className="text-sm text-content-secondary">
          {which === 'followers' ? 'Nobody follows you yet.' : 'You don’t follow anyone yet.'}
        </p>
      ) : (
        <ul className="grid gap-1">
          {people.map((person) => (
            <li key={person.username}>
              <a
                href={`/${person.username}`}
                className="flex items-center gap-3 rounded-md px-2 py-2 no-underline hover:bg-bolt-elements-background-depth-2"
              >
                <Avatar name={person.name} image={person.image} size={36} />
                <span className="min-w-0 text-sm">
                  <span className="block truncate font-semibold text-content-primary">{person.username}</span>
                  <span className="block truncate text-content-secondary">{person.name}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
