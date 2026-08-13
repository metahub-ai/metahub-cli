/**
 * Next.js app preset — base + React rules. Next ships its own ESLint
 * plugin; in flat-config land the easiest path is to apply it via the
 * compat layer in the consuming app, OR keep this preset framework-neutral
 * and let `apps/<name>/eslint.config.mjs` add `eslint-config-next` itself.
 *
 * For now this is the same as base + the JSX globals. Apps add the
 * Next rules locally where they're consumed.
 */
import base from "./base.mjs";

export default [
  ...base,
  {
    languageOptions: {
      globals: {
        React: "readonly",
        JSX: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
