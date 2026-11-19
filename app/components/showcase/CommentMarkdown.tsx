import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SKIP, visit } from 'unist-util-visit';
import type { Node, Parent } from 'unist';

/**
 * A comment's words as markdown, the way an issue's comments read on GitHub: paragraphs, lists, emphasis, code,
 * quotes, tables and links. Comments are anyone's words shown on a public page, so raw HTML is dropped, pictures are
 * shown as their links, headings read as bold lines, and links leave CloudChef in a new tab. `@someone` links to their
 * page, `@cloudchef` is bold, and `#3` goes to thread 3 on this post.
 */

/** `@username` (not inside an address) and `#3`. */
const TOKEN = /((?<![\w@./-])@[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}(?![\w-])|(?<![\w&#/])#\d{1,6}\b)/gi;

type TextNode = Node & { type: 'text'; value: string };
type InlineNode = Node & { type: string; value?: string; url?: string; children?: InlineNode[] };

function isText(node: Node): node is TextNode {
  return node.type === 'text';
}

/** Turns `@someone` and `#3` in a comment's text into links, outside code and links. */
function remarkCommentLinks() {
  return (tree: Node) => {
    visit(tree, (node: Node, index: number | undefined, parent: Parent | undefined) => {
      if (node.type === 'link' || node.type === 'inlineCode' || node.type === 'code') {
        return SKIP;
      }
      if (!isText(node) || !parent || index === undefined) {
        return undefined;
      }
      const parts = node.value.split(TOKEN);
      if (parts.length === 1) {
        return undefined;
      }
      const replaced: InlineNode[] = parts.flatMap((part, at): InlineNode[] => {
        if (!part) {
          return [];
        }
        if (at % 2 === 0) {
          return [{ type: 'text', value: part }];
        }
        if (part.startsWith('#')) {
          return [{ type: 'link', url: `#thread-${part.slice(1)}`, children: [{ type: 'text', value: part }] }];
        }
        const name = part.slice(1).toLowerCase();
        return name === 'cloudchef'
          ? [{ type: 'strong', children: [{ type: 'text', value: part }] }]
          : [{ type: 'link', url: `/${name}`, children: [{ type: 'text', value: part }] }];
      });
      parent.children.splice(index, 1, ...replaced);
      return index + replaced.length;
    });
  };
}

const REMARK_PLUGINS = [remarkGfm, remarkCommentLinks];

function components(goTo: (number: number) => void): Components {
  const bold = ({ children }: { children?: ReactNode }) => <p className="font-semibold">{children}</p>;
  return {
    a: ({ href = '', children }) => {
      const thread = /^#thread-(\d+)$/.exec(href);
      if (thread) {
        return (
          <a
            href={href}
            className="text-content-link no-underline hover:underline"
            onClick={(event) => {
              event.preventDefault();
              goTo(Number(thread[1]));
            }}
          >
            {children}
          </a>
        );
      }
      const own = href.startsWith('/') && !href.startsWith('//');
      return (
        <a
          href={href}
          className="text-content-link no-underline hover:underline"
          {...(own ? {} : { target: '_blank', rel: 'nofollow ugc noopener noreferrer' })}
        >
          {children}
        </a>
      );
    },
    // A picture is shown as its link: pictures from anywhere on a public page could track who reads it.
    img: ({ src, alt }) =>
      src ? (
        <a href={String(src)} target="_blank" rel="nofollow ugc noopener noreferrer" className="text-content-link">
          {alt || 'picture'}
        </a>
      ) : null,
    h1: bold,
    h2: bold,
    h3: bold,
    h4: bold,
    h5: bold,
    h6: bold,
    ul: ({ children }) => <ul className="ml-5 list-disc space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="ml-5 list-decimal space-y-0.5">{children}</ol>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-bolt-elements-borderColor pl-2.5 text-content-secondary">
        {children}
      </blockquote>
    ),
    code: ({ children, className }) => (
      <code
        className={
          className ? 'text-[0.85em]' : 'rounded bg-bolt-elements-background-depth-3 px-1 py-px font-mono text-[0.85em]'
        }
      >
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="overflow-x-auto rounded-md bg-bolt-elements-background-depth-3 p-2.5 font-mono text-xs">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="max-w-full overflow-x-auto">
        <table className="text-xs [&_td]:border [&_td]:border-bolt-elements-borderColor [&_td]:px-1.5 [&_th]:border [&_th]:border-bolt-elements-borderColor [&_th]:px-1.5">
          {children}
        </table>
      </div>
    ),
    hr: () => <hr className="border-bolt-elements-borderColor" />,
  };
}

export const CommentMarkdown = memo(function CommentMarkdown({
  text,
  goTo,
}: {
  text: string;
  goTo: (number: number) => void;
}) {
  return (
    <div className="grid min-w-0 gap-1.5 wrap-anywhere">
      <ReactMarkdown skipHtml remarkPlugins={REMARK_PLUGINS} components={components(goTo)}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
