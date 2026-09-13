import type { Config } from 'tailwindcss';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scrollbar = require('tailwind-scrollbar');

export default {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './app/styles/**/*.{css,scss}'],
  theme: {
    extend: {
      borderColor: {
        DEFAULT: 'rgb(var(--border-transparent-rgb))',
      },
      fontFamily: {
        // The retro theme is mono end to end. All three keys resolve to the
        // single token in variables.css so the face has one definition.
        display: ['var(--gb-font-mono)'],
        sans: ['var(--gb-font-mono)'],
        mono: ['var(--gb-font-mono)'],
      },
      borderRadius: {
        // Every named step maps to a token, so a component pasted in with a
        // stock `rounded-2xl` still lands on the theme's geometry.
        DEFAULT: 'var(--gb-radius)',
        sm: 'var(--gb-radius-sm)',
        md: 'var(--gb-radius)',
        lg: 'var(--gb-radius-lg)',
        xl: 'var(--gb-radius-lg)',
        '2xl': 'var(--gb-radius-lg)',
        '3xl': 'var(--gb-radius-lg)',
      },
      boxShadow: {
        raised: 'var(--gb-shadow-raised)',
        panel: 'var(--gb-shadow-panel)',
      },
      colors: {
        accent: {
          500: 'var(--gb-accent)',
        },
        background: {
          primary: 'rgb(var(--background-primary-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--background-secondary-rgb) / <alpha-value>)',
          tertiary: 'var(--gb-background-tertiary)',
          highlight: 'var(--gb-background-highlight)',
          success: 'var(--gb-background-success)',
          warning: 'var(--gb-background-warning)',
          error: 'var(--gb-background-error)',
          depth: {
            1: 'var(--bolt-elements-bg-depth-1)',
            2: 'var(--bolt-elements-bg-depth-2)',
            3: 'var(--bolt-elements-bg-depth-3)',
            4: 'var(--bolt-elements-bg-depth-4)',
          },
        },
        border: {
          transparent: 'var(--gb-border-transparent)',
          selected: 'var(--gb-border-selected)',
        },
        content: {
          primary: 'rgb(var(--content-primary-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--content-secondary-rgb) / <alpha-value>)',
          tertiary: 'rgb(var(--content-tertiary-rgb) / <alpha-value>)',
          accent: 'var(--gb-content-accent)',
          success: 'var(--gb-content-success)',
          warning: 'var(--gb-content-warning)',
          error: 'var(--gb-content-error)',
          link: 'var(--gb-content-link)',
        },
        util: {
          accent: 'rgb(122 162 247 / <alpha-value>)',
          success: 'rgb(158 206 106 / <alpha-value>)',
          warning: 'rgb(224 175 104 / <alpha-value>)',
        },
        bolt: {
          elements: {
            borderColor: 'var(--gb-border-transparent)',
            background: {
              depth: {
                1: 'var(--bolt-elements-bg-depth-1)',
                2: 'var(--bolt-elements-bg-depth-2)',
                3: 'var(--bolt-elements-bg-depth-3)',
                4: 'var(--bolt-elements-bg-depth-4)',
              },
            },
            code: {
              background: 'var(--bolt-elements-code-background)',
              text: 'var(--bolt-elements-code-text)',
            },
            button: {
              primary: {
                background: 'var(--bolt-elements-button-primary-background)',
                backgroundHover: 'var(--bolt-elements-button-primary-backgroundHover)',
                text: 'var(--bolt-elements-button-primary-text)',
              },
              secondary: {
                background: 'var(--bolt-elements-button-secondary-background)',
                backgroundHover: 'var(--bolt-elements-button-secondary-backgroundHover)',
                text: 'var(--bolt-elements-button-secondary-text)',
              },
              danger: {
                background: 'var(--bolt-elements-button-danger-background)',
                backgroundHover: 'var(--bolt-elements-button-danger-backgroundHover)',
                text: 'var(--bolt-elements-button-danger-text)',
              },
            },
            item: {
              contentDefault: 'var(--bolt-elements-item-contentDefault)',
              contentActive: 'var(--bolt-elements-item-contentActive)',
              contentAccent: 'var(--bolt-elements-item-contentAccent)',
              contentDanger: 'var(--bolt-elements-item-contentDanger)',
              backgroundDefault: 'var(--bolt-elements-item-backgroundDefault)',
              backgroundActive: 'var(--bolt-elements-item-backgroundActive)',
              backgroundAccent: 'var(--bolt-elements-item-backgroundAccent)',
              backgroundDanger: 'var(--bolt-elements-item-backgroundDanger)',
            },
            actions: {
              background: 'var(--bolt-elements-actions-background)',
              code: {
                background: 'var(--bolt-elements-actions-code-background)',
              },
            },
            artifacts: {
              background: 'var(--bolt-elements-artifacts-background)',
              backgroundHover: 'var(--bolt-elements-artifacts-backgroundHover)',
              borderColor: 'var(--bolt-elements-artifacts-borderColor)',
              inlineCode: {
                background: 'var(--bolt-elements-artifacts-inlineCode-background)',
                text: 'var(--bolt-elements-artifacts-inlineCode-text)',
              },
            },
            messages: {
              background: 'var(--bolt-elements-messages-background)',
              linkColor: 'var(--bolt-elements-messages-linkColor)',
              code: {
                background: 'var(--bolt-elements-messages-code-background)',
              },
              inlineCode: {
                background: 'var(--bolt-elements-messages-inlineCode-background)',
                text: 'var(--bolt-elements-messages-inlineCode-text)',
              },
            },
            icon: {
              success: 'var(--bolt-elements-icon-success)',
              error: 'var(--bolt-elements-icon-error)',
            },
            preview: {
              addressBar: {
                background: 'var(--bolt-elements-preview-addressBar-background)',
                backgroundHover: 'var(--bolt-elements-preview-addressBar-backgroundHover)',
                backgroundActive: 'var(--bolt-elements-preview-addressBar-backgroundActive)',
                text: 'var(--bolt-elements-preview-addressBar-text)',
                textActive: 'var(--bolt-elements-preview-addressBar-textActive)',
              },
            },
            terminals: {
              background: 'var(--bolt-elements-terminals-background)',
              buttonBackground: 'var(--bolt-elements-terminals-buttonBackground)',
            },
            dividerColor: 'var(--bolt-elements-dividerColor)',
            loader: {
              background: 'var(--bolt-elements-loader-background)',
              progress: 'var(--bolt-elements-loader-progress)',
            },
            prompt: {
              background: 'var(--bolt-elements-prompt-background)',
            },
            cta: {
              background: 'var(--bolt-elements-cta-background)',
              text: 'var(--bolt-elements-cta-text)',
            },
          },
        },
        gray: {
          50: '#FAFAFA',
          100: '#F5F5F5',
          200: '#E5E5E5',
          300: '#D4D4D4',
          400: '#A3A3A3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#0A0A0A',
        },
        orange: {
          50: '#FFFAEB',
          100: '#FEEFC7',
          200: '#FEDF89',
          300: '#FEC84B',
          400: '#FDB022',
          500: '#F79009',
          600: '#DC6803',
          700: '#B54708',
          800: '#93370D',
          900: '#792E0D',
        },
        red: {
          50: '#FEF2F2',
          100: '#FEE2E2',
          200: '#FECACA',
          300: '#FCA5A5',
          400: '#F87171',
          500: '#EF4444',
          600: '#DC2626',
          700: '#B91C1C',
          800: '#991B1B',
          900: '#7F1D1D',
          950: '#450A0A',
        },
        macosScrollbar: {
          thumb: 'rgba(155, 155, 155, 0.5)',
        },
      },
      maxWidth: {
        chat: 'var(--chat-max-width)',
      },
    },
  },
  plugins: [scrollbar],
} satisfies Config;
