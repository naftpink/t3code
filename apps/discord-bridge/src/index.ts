import * as NodeFS from "node:fs";
import { Bridge } from "./bridge.ts";
import { DryRunChat, type Chat } from "./chat.ts";
import { loadConfig, readSecretFile } from "./config.ts";
import { T3 } from "./t3.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = args.includes("--dry-run");

const cfg = loadConfig(flag("--config"));
const token = readSecretFile(cfg.t3.tokenFile);
if (!token)
  throw new Error(
    `No T3 token in ${cfg.t3.tokenFile}. Issue one with: t3 auth session issue --scope orchestration:read --scope orchestration:operate --token-only`,
  );

const t3 = new T3(cfg.t3.origin, token);
let chat: Chat;
if (dry) chat = new DryRunChat((k) => cfg.bots[k]?.label ?? k);
else {
  const { DiscordChat } = await import("./discord.ts");
  chat = new DiscordChat(cfg);
}
const bridge = new Bridge(cfg, t3, chat);
await bridge.init();

if (dry) {
  const script = flag("--script");
  const lines = script ? NodeFS.readFileSync(script, "utf8").split(/\r?\n/) : [];
  for (const line of lines) await (chat as DryRunChat).feed(line);
  const finished = await bridge.idle(Number(flag("--timeout") ?? 120) * 1000);
  console.log(
    finished ? "\n[dry-run] idle, done." : "\n[dry-run] timed out waiting for work to finish.",
  );
  await bridge.shutdown();
  process.exit(finished ? 0 : 1);
}

console.log("bridge running; Ctrl+C to stop");
const quit = async () => {
  await bridge.shutdown();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
