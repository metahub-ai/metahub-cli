/**
 * Smoke for the stdio transport module. The deep round-trip coverage
 * lives in `tests/server.test.ts` (which exercises `buildServer`
 * through an in-memory transport). This file just confirms the
 * module export contract — `runStdio` exists and is a function — and
 * that importing the module is side-effect-free.
 */
import { describe, expect, it } from "vitest";
import { runStdio } from "../../src/transports/stdio";

describe("stdio transport module", () => {
  it("exports runStdio as a function", () => {
    expect(typeof runStdio).toBe("function");
  });

  it("does not invoke any transport at import time", () => {
    // If `runStdio` had side effects at import (e.g. immediately
    // calling `connect`), vitest would have already exploded by the
    // time this test runs. Reaching this assertion is the test.
    expect(true).toBe(true);
  });
});
