export default {
  plugins: {
    'postcss-nesting': {},
    'postcss-mixins': {},
    // Tailwind v4 handles nesting and vendor prefixes itself.
    '@tailwindcss/postcss': {},
  },
};
