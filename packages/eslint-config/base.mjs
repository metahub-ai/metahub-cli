/**
 * MetaHub base ESLint config (flat).
 *
 * Every package extends this. Anything that crosses surfaces (CLI ↔
 * portal/registry) goes through `@metahub/shared`'s wire-format contracts —
 * this repo never imports server code.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/.cache/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/.next-env.d.ts",
      "**/next-env.d.ts",
      // Tooling configs use CJS / postcss / tailwind shapes — don't lint.
      "**/tailwind.config.js",
      "**/postcss.config.js",
      "**/next.config.{js,mjs,ts}",
      "**/*.config.cjs",
    ],
  },
  {
    // ESLint can't validate disable-comments for rules from plugins we
    // don't load (e.g. older code uses `@next/next/no-img-element`).
    // Treat unused disable directives as informational instead of errors.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { alwaysTryTypes: true },
        node: { extensions: [".js", ".jsx", ".ts", ".tsx"] },
      },
    },
    rules: {
      // @eslint/js 10 promoted `no-useless-assignment` into its recommended set.
      // The codebase intentionally uses declare-then-assign (`let x = null; … x =
      // real`) in a handful of spots, so keep this informational rather than
      // blocking — fix opportunistically (login.ts / BrowseClient.tsx already are).
      "no-useless-assignment": "warn",
      // This repo is client-toolchain only — the monorepo's app/package
      // boundary zones don't apply here. Cross-surface contracts still go
      // through @metahub/shared.
      // Unused-var rule — TS variant catches things; allow underscore prefix.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Things that hide real bugs in a wire-format project.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-console": "off",
    },
  },
  {
    // Build/tooling scripts and ESM entry files run in Node, not the browser, so
    // give them the Node globals. Without this, `js.configs.recommended`'s
    // `no-undef` flags `console`/`process`/`fetch` in plain `.mjs`/`.cjs` scripts
    // (TS files are already exempt because typescript-eslint disables `no-undef`).
    files: ["**/*.mjs", "**/scripts/**/*.{js,cjs}"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },
];
