import { Spinner } from '@ui/Spinner';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { latestLinkedPublishView } from '~/lib/common/linked-publish';
import { PublishLinks } from './ToolUseContents';
import { useLinkedPublishView } from './useLinkedPublishView';

/**
 * A GitHub project's latest publish, above the composer: its pipeline result lands after the turn that
 * published has ended, and the person should see it and its preview link without opening the activity.
 */
export function LinkedPublishStatus({ messages }: { messages: readonly CloudChefMessage[] }) {
  const view = useLinkedPublishView((now) => latestLinkedPublishView(messages, now));
  if (!view) {
    return null;
  }
  const failed = view.kind === 'failed' || view.kind === 'conflict';
  return (
    <section
      data-testid="linked-publish-status"
      role="status"
      aria-live="polite"
      className="mb-2 break-words space-y-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5 text-[13px]"
    >
      <p
        className={
          failed
            ? 'flex items-center gap-1.5 font-medium text-bolt-elements-icon-error'
            : view.kind === 'built'
              ? 'flex items-center gap-1.5 font-medium text-bolt-elements-icon-success'
              : 'flex items-center gap-1.5 font-medium text-content-primary'
        }
      >
        {view.building ? <Spinner /> : null}
        <span>{view.title}</span>
      </p>
      <p className="text-content-secondary">{view.detail}</p>
      <PublishLinks view={view} />
    </section>
  );
}
