import { createBundledHighlighter, makeSingletonHighlighter, type SpecialLanguage } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const languages = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

const themes = {
  'dark-plus': () => import('shiki/themes/dark-plus.mjs'),
  'github-dark': () => import('shiki/themes/github-dark.mjs'),
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'light-plus': () => import('shiki/themes/light-plus.mjs'),
};

type CodeLanguage = keyof typeof languages;
export type CodeTheme = keyof typeof themes;
export type HighlightLanguage = CodeLanguage | SpecialLanguage;

/** A Map rather than an object literal so an inherited key such as `constructor` cannot resolve. */
const languageAliases = new Map<string, HighlightLanguage>(
  Object.entries({
    bash: 'bash',
    css: 'css',
    html: 'html',
    js: 'javascript',
    javascript: 'javascript',
    json: 'json',
    jsx: 'jsx',
    md: 'markdown',
    markdown: 'markdown',
    plaintext: 'plaintext',
    sh: 'bash',
    shell: 'bash',
    text: 'plaintext',
    ts: 'typescript',
    tsx: 'tsx',
    typescript: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  } satisfies Record<string, HighlightLanguage>),
);

const createCodeHighlighter = createBundledHighlighter({
  langs: languages,
  themes,
  engine: createJavaScriptRegexEngine,
});

export const getCodeHighlighter = makeSingletonHighlighter(createCodeHighlighter);

export function normalizeCodeLanguage(language: string | undefined): HighlightLanguage {
  return languageAliases.get(language?.toLowerCase().replace(/^\./, '') ?? '') ?? 'plaintext';
}
