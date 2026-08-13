/**
 * `mh config get <key>` / `mh config set <key> <value>` — manage local
 * CLI preferences. Used for the telemetry opt-out and pointing the
 * CLI at a self-hosted portal/registry.
 */
import { loadAuthConfig, saveAuthConfig, type AuthConfig } from "@metahub/auth";
import { c, header, kv } from "../lib/ui.js";

type TelemetryMode = "on" | "off" | "no-handoff";

interface ConfigShape {
  telemetry: TelemetryMode;
  portalUrl: string;
  registryUrl: string;
}

const KEYS = ["telemetry", "portalUrl", "registryUrl"] as const;
type Key = (typeof KEYS)[number];

function projectConfig(cfg: AuthConfig): ConfigShape {
  return {
    telemetry: cfg.telemetry ?? "on",
    portalUrl: cfg.portalUrl,
    registryUrl: cfg.registryUrl,
  };
}

export async function config(args: string[]): Promise<number> {
  const [subcmd, key, value] = args;
  const cfg = loadAuthConfig();

  if (!subcmd || subcmd === "list" || subcmd === "ls") {
    const view = projectConfig(cfg);
    console.log(header("config", "", "~/.metahub/config.json"));
    console.log();
    console.log(kv(KEYS.map((k) => [k, String(view[k])])));
    console.log();
    console.log(`  ${c.dim("Override at runtime with METAHUB_PORTAL_URL=… mh <cmd>")}`);
    return 0;
  }

  if (subcmd === "get") {
    if (!key || !(KEYS as readonly string[]).includes(key)) {
      console.error(`Usage: mh config get <${KEYS.join("|")}>`);
      return 2;
    }
    const view = projectConfig(cfg);
    console.log(view[key as Key]);
    return 0;
  }

  if (subcmd === "set") {
    if (!key || value === undefined) {
      console.error(`Usage: mh config set <${KEYS.join("|")}> <value>`);
      return 2;
    }
    if (key === "telemetry") {
      const v = value as TelemetryMode;
      if (v !== "on" && v !== "off" && v !== "no-handoff") {
        console.error("telemetry must be one of: on | off | no-handoff");
        return 2;
      }
      saveAuthConfig({ telemetry: v });
      console.log(`${c.green("✓")} ${c.dim("telemetry →")} ${v}`);
      return 0;
    }
    if (key === "portalUrl") {
      saveAuthConfig({ portalUrl: value });
      console.log(`${c.green("✓")} ${c.dim("portalUrl →")} ${c.cyan(value)}`);
      return 0;
    }
    if (key === "registryUrl") {
      saveAuthConfig({ registryUrl: value });
      console.log(`${c.green("✓")} ${c.dim("registryUrl →")} ${c.cyan(value)}`);
      return 0;
    }
    console.error(`Unknown key: ${key}. One of ${KEYS.join("|")}.`);
    return 2;
  }

  console.error("Usage: mh config [list | get <key> | set <key> <value>]");
  return 2;
}
