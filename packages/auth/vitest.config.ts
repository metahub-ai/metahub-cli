import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@metahub/auth",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/*.test.ts", "tests/**", "src/index.ts"],
    },
  },
});
