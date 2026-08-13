import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@metahub/cli",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    // Force NO_COLOR + clear FORCE_COLOR so the UI helpers in
    // lib/ui.ts emit deterministic plain text in CI + local runs.
    // Individual tests can re-enable color via env-patch helpers
    // for the cases that need to exercise the ANSI path.
    env: {
      NO_COLOR: "1",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      include: ["src/lib/**/*.ts"],
      exclude: ["**/*.d.ts", "**/*.test.ts", "tests/**"],
    },
  },
});
