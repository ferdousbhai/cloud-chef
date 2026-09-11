import blitzPlugin from '@blitz/eslint-plugin';
import { getNamingConventionRule, tsFileExtensions } from '@blitz/eslint-plugin/dist/configs/typescript.js';
import tailwindcss from 'eslint-plugin-tailwindcss';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

const noDirectProcessEnv = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct process.env usage',
      category: 'Best Practices',
    },
    fixable: null,
    schema: [],
    messages: {
      noDirectProcessEnv:
        'Direct process.env usage is not allowed. Read runtime values from Cloudflare Worker env bindings with getOptionalBinding(env, NAME); keep process.env limited to production deploy scripts.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.object.name === 'process' && node.property.name === 'env') {
          context.report({
            node,
            messageId: 'noDirectProcessEnv',
          });
        }
      },
    };
  },
};

export default [
  {
    ignores: [
      '**/dist',
      '**/node_modules',
      '**/.wrangler',
      '**/.history',
      'scripts/fixtures/**',
      'template/**',
      '**/*.bundled.*',
      'app/generated/**',
    ],
  },
  ...blitzPlugin.configs.recommended(),
  {
    files: [...tsFileExtensions],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      local: {
        rules: {
          'no-direct-process-env': noDirectProcessEnv,
        },
      },
    },
    rules: {
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactPlugin.configs.flat['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,

      'react/prop-types': 'off',
      'import/order': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@blitz/catch-error-name': 'off',
      '@blitz/comment-syntax': 'off',
      '@blitz/block-scope-case': 'off',
      '@blitz/lines-around-comment': 'off',
      '@blitz/newline-before-return': 'off',
      'array-bracket-spacing': ['error', 'never'],
      'padding-line-between-statements': 'off',
      'multiline-comment-style': 'off',
      'object-curly-newline': ['error', { consistent: true }],
      'keyword-spacing': ['error', { before: true, after: true }],
      'consistent-return': 'error',
      semi: ['error', 'always'],
      curly: ['error'],
      'no-eval': ['error'],
      'linebreak-style': ['error', 'unix'],
      'arrow-spacing': ['error', { before: true, after: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      'prefer-arrow-callback': [
        'error',
        {
          allowNamedFunctions: true,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          message: '.bottom-4 is blocked by common ad-blocking filters; use .bottom-four instead',
          selector: 'Literal[value=/bottom-4(?:\\D|$)/i]',
        },
      ],
      'local/no-direct-process-env': 'error',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      ...getNamingConventionRule({}, true),
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['app/**/*.{js,jsx,ts,tsx}'],
    ignores: ['functions/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../'],
              message: "Relative imports are not allowed. Please use '~/' instead.",
            },
          ],
          paths: [
            {
              name: 'sonner',
              importNames: ['Toaster'],
              message: "Please import Toaster from '~/components/ui/Toaster' instead of 'sonner'.",
            },
          ],
        },
      ],
    },
  },
  ...tailwindcss.configs['flat/recommended'],
  {
    rules: {
      'tailwindcss/classnames-order': 'off',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: {
      tailwindcss,
    },
    rules: {
      'tailwindcss/no-custom-classname': 'off',
    },
  },
  {
    files: ['scripts/**/*.{cjs,js,mjs}', 'make-bootstrap-snapshot.js'],
    rules: {
      '@blitz/block-scope-case': 'off',
      '@blitz/catch-error-name': 'off',
      '@blitz/comment-syntax': 'off',
      '@blitz/lines-around-comment': 'off',
      '@blitz/newline-before-return': 'off',
      'consistent-return': 'off',
      'import/order': 'off',
      'multiline-comment-style': 'off',
      'padding-line-between-statements': 'off',
      'unicorn/prefer-node-protocol': 'off',
    },
  },
  {
    files: ['playwright.config.ts', 'e2e/**/*.ts'],
    rules: {
      // Playwright configuration and test runners execute in Node, not in a Worker.
      'local/no-direct-process-env': 'off',
    },
  },
];
