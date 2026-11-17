// Discord transport: one discord.js client per bot. The control bot owns slash commands and reads messages;
// every bot handles button presses, because Discord delivers a button click to the app that posted it.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type TextChannel,
} from "discord.js";
import { readSecretFile, type Config } from "./config.ts";
import type { Button, Chat, Handlers, SayOptions } from "./chat.ts";

const STYLE = {
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
  secondary: ButtonStyle.Secondary,
} as const;

/** Split on newlines where possible so each piece fits Discord's 2000-character limit. */
export function splitMessage(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}

export class DiscordChat implements Chat {
  private readonly cfg: Config;
  private readonly clients = new Map<string, Client>();
  private h!: Handlers;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private get control() {
    return this.clients.get(this.cfg.discord.controlBot)!;
  }
  private get allowed() {
    return this.cfg.discord.allowedUserId!;
  }
  private authorized(userId: string) {
    return userId === this.allowed;
  }

  async start(handlers: Handlers) {
    this.h = handlers;
    const { guildId, allowedUserId, controlBot } = this.cfg.discord;
    if (!allowedUserId)
      throw new Error(
        "discord.allowedUserId is required: without it anyone in the server could run commands on this machine.",
      );
    if (!guildId)
      throw new Error(
        "discord.guildId is required (slash commands are registered to that server).",
      );

    for (const [key, bot] of Object.entries(this.cfg.bots)) {
      const token = readSecretFile(bot.tokenFile);
      if (!token) {
        if (key === controlBot)
          throw new Error(
            `The control bot "${key}" needs a token file (${bot.tokenFile ?? "tokenFile not set"}).`,
          );
        console.warn(
          `[discord] no token for "${key}": its messages will be posted by the control bot instead`,
        );
        continue;
      }
      const isControl = key === controlBot;
      const client = new Client({
        intents: isControl
          ? [
              GatewayIntentBits.Guilds,
              GatewayIntentBits.GuildMessages,
              GatewayIntentBits.MessageContent,
            ]
          : [GatewayIntentBits.Guilds],
      });
      client.on(Events.InteractionCreate, (i) => {
        if (i.isButton()) void this.onButton(i);
        else if (isControl && i.isChatInputCommand()) void this.onSlash(i);
      });
      if (isControl) {
        client.on(Events.MessageCreate, (m) => {
          if (m.author.bot || !this.authorized(m.author.id) || !m.channel.isThread()) return;
          if (!this.h.isBridgeChannel(m.channelId)) return;
          void this.h
            .onMessage({ channelId: m.channelId, text: m.content })
            .catch((e) =>
              m.reply(`Couldn't send that: ${String(e).slice(0, 200)}`).catch(() => {}),
            );
        });
      }
      client.on(Events.Error, (e) => console.error(`[discord ${key}]`, e.message));
      const ready = new Promise<void>((res) => client.once(Events.ClientReady, () => res()));
      await client.login(token);
      await ready;
      console.log(`[discord] ${key} online as ${client.user?.tag}`);
      this.clients.set(key, client);
    }
    await this.registerCommands(readSecretFile(this.cfg.bots[controlBot]!.tokenFile)!);
  }

  private async registerCommands(token: string) {
    const appId = this.control.application!.id;
    const commands = [
      new SlashCommandBuilder()
        .setName("new")
        .setDescription("Start an agent in a new thread")
        .addStringOption((o) =>
          o
            .setName("agent")
            .setDescription("Which agent")
            .setRequired(true)
            .addChoices(
              ...Object.entries(this.cfg.bots).map(([value, b]) => ({ name: b.label, value })),
            ),
        )
        .addStringOption((o) =>
          o.setName("prompt").setDescription("What should it do?").setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("How much the agent may do without asking (default: from config)")
            .addChoices(
              { name: "Ask before acting", value: "approval-required" },
              { name: "Auto-accept edits", value: "auto-accept-edits" },
              { name: "Auto", value: "auto" },
              { name: "Full access", value: "full-access" },
            ),
        ),
      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Interrupt the agent in this thread"),
      new SlashCommandBuilder().setName("status").setDescription("Show this thread's agent status"),
    ].map((c) => c.toJSON());
    await new REST()
      .setToken(token)
      .put(Routes.applicationGuildCommands(appId, this.cfg.discord.guildId!), { body: commands });
    console.log("[discord] slash commands registered: /new /stop /status");
  }

  private async onSlash(i: import("discord.js").ChatInputCommandInteraction) {
    if (!this.authorized(i.user.id))
      return void i
        .reply({ content: "Not allowed.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      let text: string;
      if (i.commandName === "new") {
        // In a thread, start the new one next to it, under the same channel.
        const ch = i.channel;
        const parent = ch?.isThread() ? (ch.parentId ?? i.channelId) : i.channelId;
        const mode = i.options.getString("mode");
        text = await this.h.onNew({
          parentChannelId: parent,
          botKey: i.options.getString("agent", true),
          prompt: i.options.getString("prompt", true),
          ...(mode ? { mode } : {}),
        });
      } else if (i.commandName === "stop") text = await this.h.onStop({ channelId: i.channelId });
      else text = await this.h.onStatus({ channelId: i.channelId });
      await i.editReply(text.slice(0, 1900));
    } catch (e) {
      await i.editReply(`Error: ${String(e).slice(0, 300)}`).catch(() => {});
    }
  }

  private async onButton(i: ButtonInteraction) {
    if (!i.customId.startsWith("ap:")) return;
    if (!this.authorized(i.user.id))
      return void i
        .reply({ content: "Only the owner can answer this.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    await i.deferUpdate().catch(() => {});
    const result = await this.h
      .onButton({ customId: i.customId })
      .catch((e) => `Error: ${String(e).slice(0, 200)}`);
    await i.message
      .edit({ content: `${i.message.content}\n\n**${result}**`.slice(0, 2000), components: [] })
      .catch(() => {});
  }

  async createThread(parentChannelId: string, title: string) {
    const parent = (await this.control.channels.fetch(parentChannelId)) as TextChannel | null;
    if (!parent || parent.type !== ChannelType.GuildText)
      throw new Error("Run /new in a normal text channel.");
    const thread = await parent.threads.create({
      name: title.slice(0, 90),
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    });
    return thread.id;
  }

  async say(botKey: string, channelId: string, text: string, opts: SayOptions = {}) {
    const own = this.clients.get(botKey);
    const client = own ?? this.control;
    const prefix = own ? "" : `**${this.cfg.bots[botKey]?.label ?? botKey}:** `;
    const channel = await client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) return;
    const pieces = splitMessage(prefix + text);
    for (let n = 0; n < pieces.length; n++) {
      const last = n === pieces.length - 1;
      const row = last && opts.buttons?.length ? [this.row(opts.buttons)] : [];
      const ping = last && opts.mention ? `<@${this.allowed}> ` : "";
      await channel.send({
        content: ping + pieces[n],
        components: row,
        allowedMentions: { users: [this.allowed] },
      });
    }
  }

  private row(buttons: Button[]) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      buttons.map((b) =>
        new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(STYLE[b.style]),
      ),
    );
  }

  async typing(botKey: string, channelId: string) {
    const channel = await (this.clients.get(botKey) ?? this.control).channels
      .fetch(channelId)
      .catch(() => null);
    if (channel && "sendTyping" in channel) await channel.sendTyping().catch(() => {});
  }

  async stop() {
    await Promise.all([...this.clients.values()].map((c) => c.destroy()));
  }
}
