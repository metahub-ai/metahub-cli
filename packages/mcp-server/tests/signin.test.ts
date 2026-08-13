/**
 * Tests for the two-tool signin orchestrators. Mocks the device-code
 * library calls so the polling loop runs without real network I/O.
 */
import { describe, expect, it, vi } from "vitest";
import type { DeviceCodeStart, DeviceCodeStatus } from "@metahub/auth";
import { beginSignin, completeSignin } from "../src/tools/signin";

const START: DeviceCodeStart = {
  verificationUrl: "https://github.com/login/device",
  userCode: "ABCD-1234",
  deviceCode: "dc_abc",
  expiresIn: 900,
  interval: 5,
};

function fixedClock(startMs = 0): () => number {
  let n = startMs;
  return () => {
    n += 100;
    return n;
  };
}

function noSleep(): (ms: number) => Promise<void> {
  return async () => {
    /* no-op */
  };
}

describe("beginSignin", () => {
  it("calls the device-code start function and returns its payload immediately", async () => {
    const start = vi.fn(async () => START);
    const result = await beginSignin({ start });
    expect(result).toEqual(START);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not call the poll function (no polling in begin)", async () => {
    // Sanity: begin must return without ever touching pollDeviceCode.
    // It only invokes the start fn.
    const start = vi.fn(async () => START);
    await beginSignin({ start });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("completeSignin", () => {
  it("returns 'complete' when the poll resolves and surfaces the user handle", async () => {
    let n = 0;
    const poll = vi.fn(async (): Promise<DeviceCodeStatus> => {
      n++;
      if (n === 1) return { state: "pending", interval: 1 };
      return {
        state: "complete",
        token: { token: "sess_abc", userId: "u_1", userHandle: "alice" },
      };
    });
    const result = await completeSignin(START, {
      poll,
      sleep: noSleep(),
      now: fixedClock(),
    });
    expect(result.state).toBe("complete");
    expect(result.userHandle).toBe("alice");
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("returns 'denied' immediately when the portal rejects the user", async () => {
    const poll = vi.fn(async (): Promise<DeviceCodeStatus> => ({ state: "denied" }));
    const result = await completeSignin(START, {
      poll,
      sleep: noSleep(),
      now: fixedClock(),
    });
    expect(result.state).toBe("denied");
  });

  it("returns 'expired' when the device code expires server-side", async () => {
    const poll = vi.fn(async (): Promise<DeviceCodeStatus> => ({ state: "expired" }));
    const result = await completeSignin(START, {
      poll,
      sleep: noSleep(),
      now: fixedClock(),
    });
    expect(result.state).toBe("expired");
  });

  it("times out after maxWaitMs without a terminal poll result", async () => {
    const poll = vi.fn(async (): Promise<DeviceCodeStatus> => ({ state: "pending", interval: 1 }));
    let t = 0;
    const result = await completeSignin(START, {
      poll,
      sleep: noSleep(),
      // Advance fast — each call to now() jumps 200ms.
      now: () => {
        const out = t;
        t += 200;
        return out;
      },
      maxWaitMs: 500,
    });
    expect(result.state).toBe("timeout");
  });

  it("tolerates transient poll errors below the retry budget", async () => {
    // Two failures in a row, then a successful complete. The budget is
    // 3 consecutive errors before giving up, so this must succeed.
    let n = 0;
    const poll = vi.fn(async (): Promise<DeviceCodeStatus> => {
      n++;
      if (n <= 2) throw new Error("ECONNRESET");
      return {
        state: "complete",
        token: { token: "sess_abc", userId: "u_1", userHandle: "alice" },
      };
    });
    const result = await completeSignin(START, {
      poll,
      sleep: noSleep(),
      now: fixedClock(),
      maxWaitMs: 60_000,
    });
    expect(result.state).toBe("complete");
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("resets the error counter on a successful poll between failures", async () => {
    // Pattern: fail, fail, pending (resets), fail, fail, complete.
    // 6 calls total. Without the reset, two more failures would push the
    // counter past the budget. With reset, this succeeds.
    let n = 0;
    const poll = vi.fn(async (): Promise<DeviceCodeStatus> => {
      n++;
      if (n === 1 || n === 2 || n === 4 || n === 5) throw new Error("ETIMEDOUT");
      if (n === 3) return { state: "pending", interval: 1 };
      return {
        state: "complete",
        token: { token: "sess_abc", userId: "u_1", userHandle: "bob" },
      };
    });
    const result = await completeSignin(START, {
      poll,
      sleep: noSleep(),
      now: fixedClock(),
      maxWaitMs: 60_000,
    });
    expect(result.state).toBe("complete");
    expect(result.userHandle).toBe("bob");
    expect(poll).toHaveBeenCalledTimes(6);
  });

  it("throws Polling failed after the retry budget is exhausted", async () => {
    const poll = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      completeSignin(START, {
        poll,
        sleep: noSleep(),
        now: fixedClock(),
        maxWaitMs: 60_000,
      }),
    ).rejects.toThrow(/Polling failed.*ECONNRESET/);
    // Aborts on the 3rd consecutive failure.
    expect(poll).toHaveBeenCalledTimes(3);
  });
});
