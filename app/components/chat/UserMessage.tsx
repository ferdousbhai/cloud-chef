import { memo, type ReactNode } from 'react';
import { Markdown } from './Markdown';

interface UserMessageProps {
  content: string | Array<{ type: string; text?: string; image?: string }>;
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  let body: ReactNode;
  if (Array.isArray(content)) {
    const textItem = content.find((item) => item.type === 'text');
    const textContent = textItem?.text || '';
    const images = content.filter((item) => item.type === 'image' && item.image);

    body = (
      <div className="flex flex-col gap-2">
        {textContent && <Markdown>{textContent}</Markdown>}
        {images.map((item, index) => (
          <img
            key={index}
            src={item.image}
            alt={`Image ${index + 1}`}
            className="h-auto max-w-full rounded-lg"
            style={{ maxHeight: '512px', objectFit: 'contain' }}
          />
        ))}
      </div>
    );
  } else {
    body = <Markdown>{content}</Markdown>;
  }

  return <div className="overflow-hidden text-[13px] leading-6">{body}</div>;
});
