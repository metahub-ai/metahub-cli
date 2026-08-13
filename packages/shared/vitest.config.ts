import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@metahub/shared",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    // Separate pass from the runtime suite above: runs `tsc` directly
    // against `**/*.test-d.ts` files (Vitest's default typecheck.include).
    // Existing `tests/**/*.test.ts` runtime files are untouched — this does
    // NOT newly type-check them, it only adds tsc coverage for files
    // explicitly written as type-level regression guards (see
    // tests/contracts.test-d.ts).
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.typecheck.json",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "**/*.test.ts",
        "tests/**",
        // Pure re-export barrel — runtime is just `export *`, no logic.
        "src/index.ts",
        // Type-only modules. They look like .ts but compile to empty JS.
        "src/artifact.ts",
        "src/public.ts",
        "src/ingest.ts",
        "src/tokens.ts",
        "src/eval.ts",
        "src/api-contracts.ts",
      ],
    },
  },
});
