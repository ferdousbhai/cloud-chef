import { memo } from 'react';
import { Markdown } from './Markdown';

export const UserMessage = memo(function UserMessage({ content }: { content: string }) {
  return (
    <div className="overflow-hidden text-[13px] leading-6">
      <Markdown>{content}</Markdown>
    </div>
  );
});
