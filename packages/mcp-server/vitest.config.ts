import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@metahub/mcp-server",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
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
        // Boot wrappers — exercised end-to-end at runtime via the bin
        // shim; not unit-testable without spinning up stdio / a real
        // transport.
        "src/cli.ts",
        "src/index.ts",
        // Transport bootstrap / I/O wiring (Express HTTP listener + stdio
        // pipe). Exercised end-to-end at runtime via the bin shim; not
        // unit-testable without spinning up a real transport.
        "src/transports/http.ts",
        "src/transports/stdio.ts",
        // Pure re-export shim. No runtime code.
        "src/types.ts",
        // Environment lookups (process.env passthroughs). Both
        // `registryUrl()` and `installsFilePath()` are bypassed by
        // the tests, which inject mocks at the call sites.
        "src/env.ts",
      ],
    },
  },
});
