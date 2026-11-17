// Core logic: mirrors T3 threads into chat threads, and chat messages/buttons back into T3 commands.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Chat, Handlers } from "./chat.ts";
import { ROOT, RUNTIME_MODES, type Config } from "./config.ts";
import type { T3 } from "./t3.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = () => NodeCrypto.randomUUID();
const fence = (s: string, max = 1500) =>
  "```\n" +
  (s.length > max ? s.slice(0, max) + "\n…(truncated)" : s).replaceAll("```", "'''") +
  "\n```";

interface Mapping {
  t3ThreadId: string;
  channelId: string;
  /** Bot that opened the thread; fallback speaker. */
  botKey: string;
  title: string;
  posted: string[];
  announced: string[];
  doneRuns: string[];
}
interface PendingButton {
  threadId: string;
  requestId: string;
}
interface State {
  projectId?: string;
  threads: Record<string, Mapping>;
  buttons: Record<string, PendingButton>;
}

export class Bridge implements Handlers {
  private state: State = { threads: {}, buttons: {} };
  private readonly stateFile = process.env.BRIDGE_STATE ?? NodePath.join(ROOT, "state.json");
  private watchers = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chains = new Map<string, Promise<void>>();
  private active = new Map<string, boolean>();
  private lastTyping = new Map<string, number>();
  private stopped = false;

  private readonly cfg: Config;
  private readonly t3: T3;
  private readonly chat: Chat;

  constructor(cfg: Config, t3: T3, chat: Chat) {
    this.cfg = cfg;
    this.t3 = t3;
    this.chat = chat;
  }

  async init() {
    try {
      this.state = {
        threads: {},
        buttons: {},
        ...JSON.parse(NodeFS.readFileSync(this.stateFile, "utf8")),
      };
    } catch {
      /* first run */
    }
    await this.ensureProject();
    await this.chat.start(this);
    for (const id of Object.keys(this.state.threads)) this.watch(id);
  }

  async shutdown() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    await this.chat.stop();
    await this.t3.reset();
  }

  /** Resolves once every watched thread has no running work, or after `timeoutMs`. */
  async idle(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < deadline) {
      const busy = [...this.active.values()].some(Boolean) || this.timers.size > 0;
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 4) return true;
      await sleep(300);
    }
    return false;
  }

  private save() {
    NodeFS.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  private async ensureProject() {
    const configured = this.cfg.t3.projectId ?? this.state.projectId;
    if (configured) return void (this.state.projectId = configured);
    const root = NodePath.resolve(ROOT, this.cfg.t3.workspaceRoot);
    NodeFS.mkdirSync(root, { recursive: true });
    // Reuse a project that already covers this folder: T3 rejects a second project for the same root.
    const same = (p: string) => NodePath.resolve(p).toLowerCase() === root.toLowerCase();
    const existing = await this.t3.call((c) =>
      c["orchestration.subscribeShell"]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((items: any) => (Array.from(items)[0] as any)?.snapshot?.projects ?? []),
      ),
    );
    const found = (existing as any[]).find((p) => p.workspaceRoot && same(p.workspaceRoot));
    if (found) {
      this.state.projectId = found.id;
      this.save();
      console.log(`using existing T3 project ${found.id} at ${root}`);
      return;
    }
    const id = uuid();
    await this.t3.createProject(id, "discord-bridge", root);
    this.state.projectId = id;
    this.save();
    console.log(`created T3 project ${id} at ${root}`);
  }

  private byChannel(channelId: string) {
    return Object.values(this.state.threads).find((m) => m.channelId === channelId);
  }
  private botFor(instanceId: string | undefined, fallback: string) {
    return (
      Object.entries(this.cfg.bots).find(([, b]) => b.instanceId === instanceId)?.[0] ?? fallback
    );
  }
  private dispatch(command: Record<string, unknown>) {
    return this.t3.call((c) => c["orchestration.dispatchCommand"](command));
  }
  private projection(threadId: string) {
    return this.t3.call((c) =>
      c["orchestration.getThreadProjection"]({ threadId }),
    ) as Promise<any>;
  }
  isBridgeChannel(channelId: string) {
    return !!this.byChannel(channelId);
  }

  async onNew({
    parentChannelId,
    botKey,
    prompt,
    mode,
  }: {
    parentChannelId: string;
    botKey: string;
    prompt: string;
    mode?: string;
  }) {
    const bot = this.cfg.bots[botKey];
    const runtimeMode = mode ?? this.cfg.runtimeMode;
    if (!(RUNTIME_MODES as readonly string[]).includes(runtimeMode))
      return `Unknown mode "${runtimeMode}". Use one of: ${RUNTIME_MODES.join(", ")}`;
    if (!bot)
      return `Unknown agent "${botKey}". Available: ${Object.keys(this.cfg.bots).join(", ")}`;
    if (!prompt.trim()) return "Give the agent something to do.";
    const id = uuid();
    const title = prompt.trim().slice(0, 60);
    const channelId = await this.chat.createThread(
      parentChannelId,
      `${bot.label}: ${title}`,
      botKey,
    );
    this.state.threads[id] = {
      t3ThreadId: id,
      channelId,
      botKey,
      title,
      posted: [],
      announced: [],
      doneRuns: [],
    };
    this.save();
    try {
      await this.t3.call((c) =>
        c["orchestration.launchThread"]({
          commandId: CommandId.make(uuid()),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make(this.state.projectId!),
          title,
          modelSelection: { instanceId: ProviderInstanceId.make(bot.instanceId), model: bot.model },
          runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: prompt, attachments: [] },
        }),
      );
    } catch (e) {
      delete this.state.threads[id];
      this.save();
      await this.chat.say(
        botKey,
        channelId,
        `Couldn't start the thread: ${String(e).slice(0, 300)}`,
      );
      return `Failed to start ${bot.label}: ${String(e).slice(0, 200)}`;
    }
    this.watch(id);
    await this.chat.say(botKey, channelId, "Looking now.");
    return `Started a ${bot.label} thread: <#${channelId}>`;
  }

  async onMessage({ channelId, text }: { channelId: string; text: string }) {
    const m = this.byChannel(channelId);
    if (!m || !text.trim()) return;
    const proj = await this.projection(m.t3ThreadId);
    const running = proj.runs.find((r: any) => !TERMINAL.has(r.status));
    const dispatchMode = !running
      ? { type: "start_immediately" }
      : this.cfg.midRunMode === "steer"
        ? { type: "steer_active", targetRunId: running.id }
        : { type: "queue_after_active" };
    await this.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(uuid()),
      threadId: ThreadId.make(m.t3ThreadId),
      messageId: MessageId.make(uuid()),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "mobile",
      dispatchMode,
    });
    this.schedule(m.t3ThreadId);
  }

  async onStop({ channelId }: { channelId: string }) {
    const m = this.byChannel(channelId);
    if (!m) return "This isn't a bridged thread.";
    const proj = await this.projection(m.t3ThreadId);
    const running = proj.runs.find((r: any) => !TERMINAL.has(r.status));
    if (!running) return "Nothing is running.";
    await this.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(uuid()),
      threadId: ThreadId.make(m.t3ThreadId),
      runId: running.id,
      reason: "Stopped from chat",
    });
    return "Stopping…";
  }

  async onStatus({ channelId }: { channelId: string }) {
    const m = this.byChannel(channelId);
    if (!m) return `Bridging ${Object.keys(this.state.threads).length} thread(s).`;
    const proj = await this.projection(m.t3ThreadId);
    const pending = proj.runtimeRequests.filter((r: any) => r.status === "pending").length;
    const last = proj.runs.at(-1);
    return `${proj.thread.title} · ${proj.thread.providerInstanceId} / ${proj.thread.modelSelection?.model}\nlast run: ${last?.status ?? "none"}, runs: ${proj.runs.length}, pending approvals: ${pending}`;
  }

  async onButton({ customId }: { customId: string }) {
    const [, key, decision] = customId.split(":");
    const entry = key ? this.state.buttons[key] : undefined;
    if (!entry || !decision) return "That button has expired.";
    try {
      await this.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(uuid()),
        threadId: ThreadId.make(entry.threadId),
        requestId: entry.requestId,
        decision,
      });
    } catch (e) {
      return `Couldn't answer (already handled?): ${String(e).slice(0, 160)}`;
    }
    delete this.state.buttons[key!];
    this.save();
    this.schedule(entry.threadId);
    return decision === "decline"
      ? "❌ Declined"
      : decision === "acceptForSession"
        ? "✅ Approved for this session"
        : "✅ Approved";
  }

  /** One line on what a run did: commands run and files changed. Empty when it only talked. */
  private activity(proj: any, runId: string): string {
    const items = proj.turnItems.filter((i: any) => i.runId === runId);
    // T3 records workspace setup as a command; it is not something the agent did.
    const commands = items.filter(
      (i: any) => i.type === "command_execution" && i.title !== "Workspace ready" && i.input,
    );
    const files = [
      ...new Set<string>(
        items
          .filter((i: any) => i.type === "file_change" && i.fileName)
          .map((i: any) => String(i.fileName).split(/[\\/]/).pop()!),
      ),
    ];
    const parts: string[] = [];
    if (commands.length) {
      const shown = commands
        .slice(0, 3)
        .map((c: any) => `\`${String(c.input).replaceAll("`", "'").slice(0, 60)}\``);
      parts.push(
        `ran ${commands.length} command${commands.length > 1 ? "s" : ""} (${shown.join(", ")}${commands.length > 3 ? ", …" : ""})`,
      );
    }
    if (files.length)
      parts.push(
        `changed ${files
          .slice(0, 5)
          .map((f) => `\`${f}\``)
          .join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`,
      );
    return parts.join(" · ");
  }

  private watch(id: string) {
    if (this.watchers.has(id)) return;
    this.watchers.add(id);
    void (async () => {
      let backoff = 1000;
      while (!this.stopped && this.state.threads[id]) {
        try {
          await this.t3.call((c) =>
            c["orchestration.subscribeThread"]({ threadId: id }).pipe(
              Stream.runForEach(() => Effect.sync(() => this.schedule(id))),
            ),
          );
          backoff = 1000;
          await sleep(1000);
        } catch (e) {
          if (this.stopped) return;
          console.error(
            `[watch ${id.slice(0, 8)}] ${String(e).slice(0, 200)}; retrying in ${backoff}ms`,
          );
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
      this.watchers.delete(id);
    })();
  }

  private schedule(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        const prev = this.chains.get(id) ?? Promise.resolve();
        this.chains.set(
          id,
          prev
            .then(() => this.sync(id))
            .catch((e) => console.error(`[sync ${id.slice(0, 8)}]`, String(e).slice(0, 300))),
        );
      }, 400),
    );
  }

  private async sync(id: string) {
    const m = this.state.threads[id];
    if (!m) return;
    const proj = await this.projection(id);
    const runs = new Map<string, any>(proj.runs.map((r: any) => [r.id, r]));
    const speaker = (runId: string | undefined) =>
      this.botFor(runId ? runs.get(runId)?.providerInstanceId : undefined, m.botKey);

    // 1. Finished assistant messages.
    const messages = proj.messages
      .filter(
        (x: any) =>
          x.role === "assistant" && !x.streaming && x.text?.trim() && !m.posted.includes(x.id),
      )
      .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const msg of messages) {
      m.posted.push(msg.id);
      this.save();
      await this.chat.say(speaker(msg.runId), m.channelId, msg.text);
    }

    // 2. Pending approvals / questions.
    for (const r of proj.runtimeRequests) {
      if (r.status !== "pending" || m.announced.includes(r.id)) continue;
      m.announced.push(r.id);
      const item = proj.turnItems.find(
        (i: any) =>
          (i.type === "approval_request" || i.type === "user_input_request") &&
          i.requestId === r.id,
      );
      const who = speaker(item?.runId);
      if (item?.type === "approval_request") {
        const key = uuid().slice(0, 8);
        this.state.buttons[key] = { threadId: id, requestId: r.id };
        this.save();
        await this.chat.say(
          who,
          m.channelId,
          `**Approval needed** (${item.requestKind})\n${fence(item.prompt ?? item.reason ?? "No details given.")}`,
          {
            mention: true,
            buttons: [
              { id: `ap:${key}:accept`, label: "Approve", style: "success" },
              { id: `ap:${key}:acceptForSession`, label: "Allow for session", style: "secondary" },
              { id: `ap:${key}:decline`, label: "Decline", style: "danger" },
            ],
          },
        );
      } else {
        this.save();
        await this.chat.say(
          who,
          m.channelId,
          "I need an answer to a question, which Discord can't relay yet. Please answer it in the T3 app.",
          { mention: true },
        );
      }
    }

    // 3. Runs that just finished.
    for (const run of proj.runs) {
      if (!TERMINAL.has(run.status) || m.doneRuns.includes(run.id)) continue;
      m.doneRuns.push(run.id);
      this.save();
      const note =
        run.status === "completed"
          ? "✅ Done."
          : run.status === "failed"
            ? "⚠️ The run failed."
            : "⏹ Stopped.";
      const did = this.activity(proj, run.id);
      await this.chat.say(speaker(run.id), m.channelId, did ? `${note}\n${did}` : note, {
        mention: this.cfg.pingOnDone,
      });
    }

    // 4. Activity tracking and typing indicator.
    const busy = proj.runs.some((r: any) => !TERMINAL.has(r.status));
    const waiting = proj.runtimeRequests.some((r: any) => r.status === "pending");
    this.active.set(id, busy);
    if (busy && !waiting && Date.now() - (this.lastTyping.get(id) ?? 0) > 8000) {
      this.lastTyping.set(id, Date.now());
      await this.chat.typing(m.botKey, m.channelId);
    }
    // Drop buttons whose request is no longer pending.
    for (const [key, b] of Object.entries(this.state.buttons)) {
      if (
        b.threadId === id &&
        !proj.runtimeRequests.some((r: any) => r.id === b.requestId && r.status === "pending")
      )
        delete this.state.buttons[key];
    }
  }
}
