import { memo } from 'react';
import { Markdown } from './Markdown';

export const UserMessage = memo(function UserMessage({ content }: { content: string }) {
  return (
    <div className="overflow-hidden text-sm">
      <Markdown>{content}</Markdown>
    </div>
  );
});
