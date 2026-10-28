import { useEffect, useState, type CSSProperties } from 'react';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { getCodeHighlighter, normalizeCodeLanguage, type CodeTheme, type HighlightLanguage } from '~/lib/shiki.client';

const logger = createScopedLogger('HighlightedCode');

type HighlightToken = {
  content: string;
  color?: string;
  bgColor?: string;
  fontStyle?: number;
};

type HighlightedCode = {
  tokens: HighlightToken[][];
  bg?: string;
  fg?: string;
};

export function useHighlightedCode(code: string, language: string, theme: CodeTheme): HighlightedCode | null {
  // The highlighting with what it highlighted: for any other code, language or theme there is none yet.
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    theme: CodeTheme;
    value: HighlightedCode;
  } | null>(null);

  useEffect(() => {
    const normalizedLanguage = normalizeCodeLanguage(language);
    let active = true;

    void getCodeHighlighter({
      langs: isLoadableLanguage(normalizedLanguage) ? [normalizedLanguage] : [],
      themes: [theme],
    })
      .then((highlighter) => {
        if (active) {
          setHighlighted({
            code,
            language,
            theme,
            value: highlighter.codeToTokens(code, { lang: normalizedLanguage, theme }),
          });
        }
      })
      .catch((error) => {
        if (active) {
          logger.warn('Failed to highlight code block', error);
        }
      });

    return () => {
      active = false;
    };
  }, [code, language, theme]);

  return highlighted?.code === code && highlighted.language === language && highlighted.theme === theme
    ? highlighted.value
    : null;
}

export function highlightTokenStyle(token: HighlightToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    color: token.color,
    backgroundColor: token.bgColor,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 'bold' : undefined,
    textDecoration: fontStyle & 4 ? 'underline' : undefined,
  };
}

function isLoadableLanguage(language: HighlightLanguage): language is Exclude<HighlightLanguage, 'plaintext' | 'text'> {
  return language !== 'plaintext' && language !== 'text';
}
