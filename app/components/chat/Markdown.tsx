import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { markdownRehypePlugins, markdownRemarkPlugins } from '~/utils/markdown';
import { allowedHTMLElements } from 'cloudchef-agent/allowed-html-elements';
import { CodeBlock } from './CodeBlock';

import styles from './Markdown.module.css';

const logger = createScopedLogger('MarkdownComponent');

interface MarkdownProps {
  children: string;
}

const markdownComponents = {
  pre: (props) => {
    const { children, node, ...preProps } = props;
    const [firstChild] = node?.children ?? [];
    const firstCodeChild = firstChild?.type === 'element' ? firstChild.children[0] : undefined;

    if (firstChild?.type === 'element' && firstChild.tagName === 'code' && firstCodeChild?.type === 'text') {
      const { className, ...codeProps } = firstChild.properties;
      const [, language = 'plaintext'] = /language-(\w+)/.exec(String(className) || '') ?? [];

      return <CodeBlock code={firstCodeChild.value} language={language} {...codeProps} />;
    }

    return <pre {...preProps}>{children}</pre>;
  },
} satisfies Components;

export const Markdown = memo(function Markdown({ children }: MarkdownProps) {
  logger.trace('Render');

  return (
    <ReactMarkdown
      allowedElements={allowedHTMLElements}
      className={styles.MarkdownContent}
      components={markdownComponents}
      remarkPlugins={markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
    >
      {children}
    </ReactMarkdown>
  );
});
