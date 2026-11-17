# Discord bridge

Starts, steers and approves T3 Code agent threads from Discord. Each provider speaks through its own
bot, so Claude and Codex show up as separate participants.

It is a client of the server's public RPC protocol (`@t3tools/contracts`), not part of the server, so it
can run on the same machine or anywhere that can reach the server.

## Setup

1. Create one Discord application per provider (a bot each). Turn on the **Message Content Intent** on
   the control bot. Invite each to your server with scope `bot applications.commands` and permissions
   `309237713920` (View Channels, Send Messages, Read Message History, Create Public Threads, Send
   Messages in Threads).
2. Issue a scoped token for the bridge. It needs only orchestration access:
   `t3 auth session issue --scope orchestration:read --scope orchestration:operate --label discord-bridge --token-only`
3. Copy `config.example.json` to `config.json`. Set `guildId`, and `allowedUserId` to **your** Discord user
   ID: only that account can run commands or press buttons.
4. Put each bot token in the file named by its `tokenFile` (under `.secrets/`, git-ignored).

## Commands

- `/new agent prompt [project] [mode]` starts a thread in a new Discord thread. `project` overrides the current
  project for this thread only; `mode` sets how much the agent may do without asking.
- `/project list` shows your T3 projects, with the current one marked.
- `/project use name` switches the current project; later `/new` threads start there, and the choice survives restarts.
- `/project add path [name]` registers a folder on the T3 machine as a project and switches to it. The path must
  already exist.
- `/stop` interrupts the agent in the current thread. `/status` shows the thread, or the current project outside one.

## Run

```
pnpm --filter @t3tools/discord-bridge start
pnpm --filter @t3tools/discord-bridge dry-run -- --config config.json --script script.txt
```

`--dry-run` prints what Discord would show and takes commands from a script file (`/new <bot> <prompt>`,
`> <message>`, `/stop`, `/status`, `/click <decision>`, `wait <ms>`), so it works without Discord.
