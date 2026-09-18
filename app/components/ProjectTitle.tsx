import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const inlineComponents: Components = {
  p: ({ children }) => <>{children}</>,
  code: ({ children }) => (
    <code className="rounded bg-[var(--cc-background-secondary)] px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
  ),
};

export const ProjectTitle = memo(function ProjectTitle({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={className}>
      <ReactMarkdown
        allowedElements={['p', 'strong', 'em', 'del', 'code']}
        components={inlineComponents}
        remarkPlugins={[remarkGfm]}
        skipHtml
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </span>
  );
});
