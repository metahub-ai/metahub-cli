/**
 * Device-code flow primitives.
 *
 * The portal's existing endpoints (`/api/auth/github/start`,
 * `/api/auth/github/poll`) drive a GitHub OAuth flow: the user visits
 * `verificationUri`, enters `userCode`, the portal sees the OAuth
 * callback land, and the next poll returns `state: "complete"` with a
 * MetaHub session token.
 *
 * TODO: when the portal exposes a native MCP-friendly endpoint
 * (e.g. `/api/auth/device-code` with no GitHub redirect), swap the
 * implementation below without changing this module's public shape.
 */
import { pollDeviceFlow, startDeviceFlow } from "./portal-api.js";
import { persistToken, type AuthToken } from "./token.js";

export interface DeviceCodeStart {
  /** URL the user should visit to authenticate. */
  verificationUrl: string;
  /** Short code the user types on that URL. */
  userCode: string;
  /** Opaque handle the caller polls. */
  deviceCode: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Polling interval in seconds. */
  interval: number;
}

export type DeviceCodeStatus =
  | { state: "pending"; interval: number }
  | { state: "complete"; token: AuthToken }
  | { state: "denied" }
  | { state: "expired" };

/**
 * Start the device-code flow. Returns immediately with the URL + user
 * code the caller surfaces to the user.
 */
export async function startDeviceCodeFlow(): Promise<DeviceCodeStart> {
  const r = await startDeviceFlow();
  return {
    verificationUrl: r.verificationUri,
    userCode: r.userCode,
    deviceCode: r.deviceCode,
    expiresIn: r.expiresIn,
    interval: r.interval,
  };
}

/**
 * Issue one poll for the given device code. Callers that want a
 * blocking wait can loop `while (status.state === "pending")` with
 * `await sleep(status.interval * 1000)` between attempts. The
 * library deliberately does not own the loop — that keeps the MCP
 * server free to surface progress between polls.
 *
 * On `state: "complete"` the returned token is also persisted to
 * `~/.metahub/config.json` so subsequent CLI / MCP-server calls see it.
 */
export async function pollDeviceCode(deviceCode: string): Promise<DeviceCodeStatus> {
  const r = await pollDeviceFlow(deviceCode);
  if (r.state === "complete") {
    const token: AuthToken = {
      token: r.token,
      userId: r.user.id,
      userHandle: r.user.githubLogin,
    };
    persistToken(token);
    return { state: "complete", token };
  }
  if (r.state === "slow_down") {
    return { state: "pending", interval: r.interval };
  }
  if (r.state === "denied" || r.state === "expired") {
    return { state: r.state };
  }
  return { state: "pending", interval: 0 };
}
