// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off globalFetch:off cryptoRandomUUID:off anyUnknownInErrorContext:off - Standalone bot process written as plain async Node; Effect is used only where the RPC client requires it.
// The bridge talks to chat through this interface, so it can be tested without Discord (DryRunChat).

export interface Button {
  id: string;
  label: string;
  style: "success" | "danger" | "secondary";
}

export interface SayOptions {
  buttons?: Button[];
  /** Ping the allowed user. */
  mention?: boolean;
}

export interface Handlers {
  /** `/new`: returns the text to answer the slash command with. */
  onNew(c: {
    parentChannelId: string;
    botKey: string;
    prompt: string;
    mode?: string;
    project?: string;
  }): Promise<string>;
  /** `/project list|use|add`. */
  onProject(c: { action: string; name?: string; path?: string }): Promise<string>;
  /** Autocomplete for project fields: up to 25 {name, value} matches. */
  projectChoices(query: string): Promise<Array<{ name: string; value: string }>>;
  /** A plain message from the allowed user inside a bridged thread. */
  onMessage(c: { channelId: string; text: string }): Promise<void>;
  onStop(c: { channelId: string }): Promise<string>;
  onStatus(c: { channelId: string }): Promise<string>;
  /** An Approve/Decline button was pressed; returns the text to show on the message afterwards. */
  onButton(c: { customId: string }): Promise<string>;
  isBridgeChannel(channelId: string): boolean;
}

export interface Chat {
  start(handlers: Handlers): Promise<void>;
  /** Create a thread under a channel and return its id. */
  createThread(parentChannelId: string, title: string, botKey: string): Promise<string>;
  say(botKey: string, channelId: string, text: string, opts?: SayOptions): Promise<void>;
  typing(botKey: string, channelId: string): Promise<void>;
  stop(): Promise<void>;
}

/** Prints what Discord would show and takes commands from a script. */
export class DryRunChat implements Chat {
  private h!: Handlers;
  private lastThread = "";
  private n = 0;
  private lastButtons: Button[] = [];
  private readonly labelOf: (botKey: string) => string;
  constructor(labelOf: (botKey: string) => string) {
    this.labelOf = labelOf;
  }

  async start(handlers: Handlers) {
    this.h = handlers;
  }
  async createThread(_parent: string, title: string, botKey: string) {
    this.lastThread = `thread-${++this.n}`;
    console.log(
      `[discord] new thread #${this.lastThread} "${title}" (opened as ${this.labelOf(botKey)})`,
    );
    return this.lastThread;
  }
  async say(botKey: string, channelId: string, text: string, opts: SayOptions = {}) {
    const ping = opts.mention ? "@you " : "";
    const body = text
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    console.log(`[${this.labelOf(botKey)} -> #${channelId}] ${ping}\n${body}`);
    if (opts.buttons?.length) this.lastButtons = opts.buttons;
    if (opts.buttons?.length)
      console.log(`    buttons: ${opts.buttons.map((b) => `${b.label} {${b.id}}`).join("  |  ")}`);
  }
  async typing() {}
  async stop() {}

  /** One script line: `/new <bot> <prompt>`, `> <message>`, `/stop`, `/status`, `/click <id>`, `wait <ms>`. */
  async feed(line: string) {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    console.log(`\n>>> ${t}`);
    if (t.startsWith("wait "))
      return void (await new Promise((r) => setTimeout(r, Number(t.slice(5)))));
    if (t.startsWith("/new ")) {
      // `/new <bot> [--mode <mode>] <prompt>`
      const [, bot, ...rest] = t.split(/\s+/);
      const at = rest.indexOf("--mode");
      const mode = at >= 0 ? rest.splice(at, 2)[1] : undefined;
      const pat = rest.indexOf("--project");
      const project = pat >= 0 ? rest.splice(pat, 2)[1] : undefined;
      console.log(
        "[reply]",
        await this.h.onNew({
          parentChannelId: "main",
          botKey: bot!,
          prompt: rest.join(" "),
          ...(mode ? { mode } : {}),
          ...(project ? { project } : {}),
        }),
      );
    } else if (t.startsWith("/project ")) {
      // `/project list` | `/project use <name>` | `/project add <path> [name]`
      const [, action, ...rest] = t.split(/\s+/);
      const arg = rest.join(" ");
      const call =
        action === "add"
          ? {
              action,
              path: rest[0] ?? "",
              ...(rest.length > 1 ? { name: rest.slice(1).join(" ") } : {}),
            }
          : { action: action ?? "", ...(arg ? { name: arg } : {}) };
      console.log("[reply]", await this.h.onProject(call));
    } else if (t.startsWith("> "))
      await this.h.onMessage({ channelId: this.lastThread, text: t.slice(2) });
    else if (t === "/stop")
      console.log("[reply]", await this.h.onStop({ channelId: this.lastThread }));
    else if (t === "/status")
      console.log("[reply]", await this.h.onStatus({ channelId: this.lastThread }));
    else if (t.startsWith("/click ")) {
      // `/click accept` picks the last-shown button whose decision matches; a full id also works.
      const arg = t.slice(7).trim();
      const b = this.lastButtons.find((x) => x.id === arg || x.id.endsWith(`:${arg}`));
      console.log("[reply]", await this.h.onButton({ customId: b?.id ?? arg }));
    } else console.log("(unknown script line)");
  }
}
