import { Fragment, memo, useEffect, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { CheckIcon, ClipboardIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import type { CodeTheme } from '~/lib/shiki.client';
import { highlightTokenStyle, useHighlightedCode } from './useHighlightedCode';

interface CodeBlockProps {
  className?: string;
  code: string;
  language?: string;
  theme?: CodeTheme;
}

export const CodeBlock = memo(function CodeBlock({
  className,
  code,
  language = 'plaintext',
  theme = 'dark-plus',
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const highlighted = useHighlightedCode(code, language, theme);

  const copyToClipboard = async () => {
    if (copied) {
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard access can be denied by browser permissions.
    }
  };

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timeout = window.setTimeout(() => setCopied(false), 1000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <div className={classNames('relative group', className)}>
      <div
        className={classNames('absolute top-2 right-2 opacity-0 group-hover:opacity-100', {
          'opacity-100': copied,
        })}
      >
        <Button
          variant="neutral"
          icon={copied ? <CheckIcon className="text-util-success" /> : <ClipboardIcon />}
          onClick={() => void copyToClipboard()}
          tip="Copy Code"
        />
      </div>
      <pre className="shiki" style={{ backgroundColor: highlighted?.bg, color: highlighted?.fg }}>
        <code>
          {highlighted?.tokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={highlightTokenStyle(token)}>
                  {token.content}
                </span>
              ))}
              {lineIndex < highlighted.tokens.length - 1 ? '\n' : null}
            </Fragment>
          )) ?? code}
        </code>
      </pre>
    </div>
  );
});
