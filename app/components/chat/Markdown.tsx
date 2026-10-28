import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { markdownRehypePlugins, markdownRemarkPlugins } from '~/utils/markdown';
import { allowedHTMLElements } from 'cloudchef-agent/allowed-html-elements';
import { CodeBlock } from './CodeBlock';

import styles from './Markdown.module.css';

interface MarkdownProps {
  children: string;
}

const markdownComponents = {
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  ),
  pre: (props) => {
    const { children, node, ...preProps } = props;
    const [firstChild] = node?.children ?? [];
    const firstCodeChild = firstChild?.type === 'element' ? firstChild.children[0] : undefined;

    if (firstChild?.type === 'element' && firstChild.tagName === 'code' && firstCodeChild?.type === 'text') {
      const [, language = 'plaintext'] = /language-(\w+)/.exec(String(firstChild.properties.className) || '') ?? [];

      return <CodeBlock code={firstCodeChild.value} language={language} />;
    }

    return <pre {...preProps}>{children}</pre>;
  },
} satisfies Components;

export const Markdown = memo(function Markdown({ children }: MarkdownProps) {
  return (
    <div className={styles.MarkdownContent}>
      <ReactMarkdown
        allowedElements={allowedHTMLElements}
        components={markdownComponents}
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
