# DeepSeek

T3 Code can run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a DeepSeek agent. It talks to `dsh` over ACP and uses the sign-in and configuration `dsh` keeps on the machine that runs the T3 Code server.

## Set up DeepSeek

1. Install DeepSeek Harness on that machine. The desktop app bundles the command as `resources\runtime\cli\bin\dsh.cmd` in its install folder. If `dsh` is not on the server's `PATH`, set **Binary path** to that file.
2. Open **Settings → Providers**, add **DeepSeek**, and refresh the provider.

## Sign-in and balance

The model list has two routes. **account** models run on the sign-in DeepSeek Harness keeps from its desktop app. **API key** models need `DEEPSEEK_API_KEY` in the instance's environment, which T3 Code passes to `dsh`. With that key set, T3 Code also reads your account balance from `api.deepseek.com`, shows it next to the sign-in state, and adds a **Balance** bar to Usage → Limits. DeepSeek reports only what is left, so the bar measures use against the highest balance T3 Code has seen: it starts full, drains as you spend, and refills when you top up. It warns when DeepSeek rejects the key or reports no available balance.

**Default** runs the model your `dsh` profile selects, which is an API-key model unless you changed it.

## Models and permissions

The picker lists the models `dsh` advertises, with a **Reasoning effort** control (Off, Low, High, Max). Add any other model ID `dsh` accepts as a custom model in the provider settings; its ID is the route and model as `dsh` writes them, for example `["deepseek-account","deepseek-v4-pro"]`.

The composer shows how much of the model's context window the thread uses.

DeepSeek threads always run **Supervised**: `dsh` asks before it changes files or runs commands, and each request comes to you.
