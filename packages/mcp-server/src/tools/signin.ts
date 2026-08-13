/**
 * `metahub_signin_begin` / `metahub_signin_complete` — orchestrate the
 * GitHub device-code flow against the portal across two tool calls.
 *
 * MCP sends one response per tool call, AFTER the handler returns, so a
 * single tool that starts the flow and then blocks polling deadlocks:
 * the verification URL never reaches the AI client until polling
 * completes, but polling won't complete until the user visits the URL.
 * Splitting in two lets the AI surface the URL first, then resume
 * polling in a second call once the user has opened the URL.
 *
 * Library API (`@metahub/auth`):
 *   startDeviceCodeFlow() → { verificationUrl, userCode, deviceCode, expiresIn, interval }
 *   pollDeviceCode(deviceCode) → { state: "pending" | "complete" | "denied" | "expired", … }
 *
 * `pollDeviceCode` already calls `persistToken` on `state: "complete"`.
 */
import { pollDeviceCode, startDeviceCodeFlow, type DeviceCodeStatus } from "@metahub/auth";

export interface SigninResult {
  state: "complete" | "denied" | "expired" | "timeout";
  /** Surfaces the verification URL/code so the AI can render them. */
  verificationUrl: string;
  userCode: string;
  /** Set on `state: "complete"`. */
  userHandle?: string;
}

export interface SigninOptions {
  /** Test seam — override the device-flow start call. */
  start?: typeof startDeviceCodeFlow;
  /** Test seam — override the polling call. */
  poll?: typeof pollDeviceCode;
  /**
   * Hard cap on how long we wait for the user to finish OAuth. Defaults
   * to 5 minutes. The portal sends its own `expiresIn` (typically 15
   * min) but tools held open too long block the AI client, so we stop
   * earlier on our side and let the AI prompt the user to retry.
   */
  maxWaitMs?: number;
  /**
   * Sleep function — defaults to `setTimeout`. Tests override to
   * fast-forward without real waits.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Clock — tests override to fast-forward elapsed time. */
  now?: () => number;
}

const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;
/**
 * Tolerate this many consecutive transient errors from `pollDeviceCode`
 * before giving up. A single network blip during a 5-minute poll loop
 * is plausible; throwing on the first one would abort an otherwise
 * healthy signin. The counter resets on every successful poll.
 */
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Begin the device-code flow. Returns the verification URL/code the AI
 * should surface to the user, plus the `deviceCode` handle to pass back
 * to {@link completeSignin}.
 */
export async function beginSignin(opts: Pick<SigninOptions, "start"> = {}): Promise<{
  verificationUrl: string;
  userCode: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}> {
  const startFn = opts.start ?? startDeviceCodeFlow;
  return startFn();
}

/**
 * Poll until the user completes the OAuth dance (or we time out).
 * `pollDeviceCode` from `@metahub/auth` already persists the token on
 * success, so this function does not write to disk itself.
 *
 * Tolerates up to {@link MAX_CONSECUTIVE_POLL_ERRORS} consecutive
 * transient errors from `pollDeviceCode`; the counter resets on each
 * successful poll. Crossing the threshold throws `Polling failed: ...`
 * with the most recent error as the cause.
 */
export async function completeSignin(
  input: {
    verificationUrl: string;
    userCode: string;
    deviceCode: string;
    interval: number;
  },
  opts: SigninOptions = {},
): Promise<SigninResult> {
  const pollFn = opts.poll ?? pollDeviceCode;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const startedAt = now();
  let interval = Math.max(input.interval, 1);
  let consecutiveErrors = 0;

  while (now() - startedAt < maxWaitMs) {
    await sleep(interval * 1000);
    let status: DeviceCodeStatus;
    try {
      status = await pollFn(input.deviceCode);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw new Error(`Polling failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
      continue;
    }
    if (status.state === "complete") {
      return {
        state: "complete",
        verificationUrl: input.verificationUrl,
        userCode: input.userCode,
        userHandle: status.token.userHandle || undefined,
      };
    }
    if (status.state === "denied" || status.state === "expired") {
      return {
        state: status.state,
        verificationUrl: input.verificationUrl,
        userCode: input.userCode,
      };
    }
    interval = Math.max(status.interval || interval, 1);
  }

  return {
    state: "timeout",
    verificationUrl: input.verificationUrl,
    userCode: input.userCode,
  };
}
