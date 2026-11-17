// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off globalFetch:off cryptoRandomUUID:off anyUnknownInErrorContext:off - Standalone bot process written as plain async Node; Effect is used only where the RPC client requires it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const ROOT = NodePath.resolve(import.meta.dirname, "..");

export interface BotConfig {
  /** Name shown in logs and in dry-run output. */
  label: string;
  /** T3 provider instance this bot speaks for, e.g. "claudeAgent" or "codex". */
  instanceId: string;
  /** Model used when this bot starts a thread. */
  model: string;
  /** File holding this bot's Discord token. Missing file = this bot falls back to the control bot. */
  tokenFile?: string;
}

export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface Config {
  t3: { origin: string; tokenFile: string; projectId?: string; workspaceRoot: string };
  discord: { guildId?: string; allowedUserId?: string; controlBot: string };
  /** Keyed by short bot name used in `/new agent:<name>`. */
  bots: Record<string, BotConfig>;
  /** Default for new threads; `/new mode:` overrides it per thread. */
  runtimeMode: RuntimeMode;
  /** What a Discord message does while a run is active: queue it, or steer the running turn. */
  midRunMode: "queue" | "steer";
  pingOnDone: boolean;
}

export function loadConfig(file = NodePath.join(ROOT, "config.json")): Config {
  const raw = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Partial<Config>;
  const cfg: Config = {
    t3: {
      origin: "http://127.0.0.1:13773",
      tokenFile: ".secrets/t3-token.txt",
      workspaceRoot: "sandbox",
      ...raw.t3,
    },
    discord: { controlBot: Object.keys(raw.bots ?? {})[0] ?? "", ...raw.discord },
    bots: raw.bots ?? {},
    runtimeMode: raw.runtimeMode ?? "approval-required",
    midRunMode: raw.midRunMode ?? "queue",
    pingOnDone: raw.pingOnDone ?? true,
  };
  if (Object.keys(cfg.bots).length === 0) throw new Error("config.json needs at least one bot");
  if (!cfg.bots[cfg.discord.controlBot])
    throw new Error(`controlBot "${cfg.discord.controlBot}" is not in bots`);
  return cfg;
}

export function readSecretFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const p = NodePath.isAbsolute(file) ? file : NodePath.join(ROOT, file);
  try {
    const v = NodeFS.readFileSync(p, "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}
