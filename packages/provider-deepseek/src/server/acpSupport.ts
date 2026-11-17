import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import type { DeepSeekSettings } from "../settings.ts";

export const DEEPSEEK_DRIVER_KIND = ProviderDriverKind.make("deepseek");
/** `dsh` enforces no sandbox of its own that T3 can rely on, so only approval-gated runs are offered. */
export const DEEPSEEK_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
] as const satisfies ReadonlyArray<RuntimeMode>;

interface DeepSeekAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly deepSeekSettings: Pick<DeepSeekSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
}

/** `dsh --profile acp` serves ACP over stdio until the client disconnects. */
export const makeDeepSeekAcpRuntime = Effect.fn("makeDeepSeekAcpRuntime")(function* (
  input: DeepSeekAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { deepSeekSettings, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: deepSeekSettings.binaryPath || "dsh",
        args: ["--profile", "acp"],
        cwd: input.cwd,
        env: { ...environment },
      },
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
