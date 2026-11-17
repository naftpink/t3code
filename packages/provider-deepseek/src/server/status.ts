import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  type ProviderOptionDescriptor,
  type ServerProviderAuth,
  type ServerProviderUsageLimits,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as HttpClient from "effect/http/HttpClient";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  providerProbeEnvironment,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

import type { DeepSeekSettings } from "../settings.ts";
import { DEEPSEEK_DRIVER_KIND, DEEPSEEK_SUPPORTED_RUNTIME_MODES } from "./acpSupport.ts";
import {
  deepSeekBalanceWindows,
  readDeepSeekAccount,
  type DeepSeekBalanceBaselineStore,
} from "./balance.ts";
import { makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

export const DEEPSEEK_DEFAULT_MODEL_SLUG = "default";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportedRuntimeModes: DEEPSEEK_SUPPORTED_RUNTIME_MODES,
} as const;
/** The config id and values `dsh --profile acp` advertises for reasoning effort. */
const DEEPSEEK_EFFORT_OPTION_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "reasoning_effort",
  label: "Reasoning effort",
  type: "select",
  options: [
    { id: "off", label: "Off" },
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
  ],
};
const DEEPSEEK_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [DEEPSEEK_EFFORT_OPTION_DESCRIPTOR],
});

/**
 * `dsh` has no models command, and listing needs an ACP session, so the snapshot carries the
 * models its session advertises today: a model slug is dsh's own option value, a JSON route and
 * model id. "Official" runs on `DEEPSEEK_API_KEY`; "account" runs on the DeepSeek Harness login.
 * "Default" keeps whatever the dsh profile selects.
 */
const DEEPSEEK_LISTED_MODELS = [
  { slug: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash (API key)" },
  { slug: '["deepseek-account","deepseek-flash"]', name: "DeepSeek-V4.1-Flash (account)" },
  { slug: '["deepseek-account","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro (account)" },
] as const;

const deepSeekModels = (settings: DeepSeekSettings): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(
    [
      {
        slug: DEEPSEEK_DEFAULT_MODEL_SLUG,
        name: "Default",
        isCustom: false,
        isDefault: true,
        capabilities: DEEPSEEK_MODEL_CAPABILITIES,
      },
      ...DEEPSEEK_LISTED_MODELS.map((model) => ({
        ...model,
        isCustom: false,
        capabilities: DEEPSEEK_MODEL_CAPABILITIES,
      })),
    ],
    settings.customModels,
    DEEPSEEK_MODEL_CAPABILITIES,
  );

const snapshot = (
  settings: DeepSeekSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: DEEPSEEK_DRIVER_KIND,
    presentation: DEEPSEEK_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: deepSeekModels(settings),
    probe,
  }),
  // dsh persists every ACP session and ACP has no delete, so throwaway sessions would pile up.
  supportsTextGeneration: false,
});

export const buildInitialDeepSeekProviderSnapshot = (
  settings: DeepSeekSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking DeepSeek Harness availability..."
        : "DeepSeek is disabled in T3 Code settings.",
    }),
  );

const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * Reads `dsh --version`, then the account balance when `DEEPSEEK_API_KEY` is set.
 * Neither opens an ACP session. Sign-in stays unknown without a key: `dsh` owns its own credentials.
 */
export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv,
  baselineStore: DeepSeekBalanceBaselineStore,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "DeepSeek is disabled in T3 Code settings.",
    });
  }

  const command = settings.binaryPath || "dsh";
  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* resolveSpawnCommand(command, ["--version"], {
    env: probeEnvironment,
  }).pipe(
    Effect.flatMap((spawnCommand) =>
      spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: probeEnvironment,
          shell: spawnCommand.shell,
        }),
      ),
    ),
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("deepseek", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "DeepSeek Harness (`dsh`) is not installed or not on PATH."
        : "Failed to run `dsh --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "DeepSeek Harness is installed but failed to run.",
    });
  }

  const account = yield* readDeepSeekAccount(environment);
  const auth: ServerProviderAuth =
    account === undefined
      ? { status: "unknown" }
      : account.keyRejected
        ? { status: "unauthenticated" }
        : account.balanceLabel === undefined
          ? { status: "unknown" }
          : { status: "authenticated", label: account.balanceLabel };
  const probe =
    account?.keyRejected === true
      ? { status: "error" as const, message: "DeepSeek rejected DEEPSEEK_API_KEY." }
      : account?.available === false
        ? {
            status: "warning" as const,
            message: "DeepSeek reports no available balance. Top up to keep running turns.",
          }
        : { status: "ready" as const };
  let usageLimits: ServerProviderUsageLimits | undefined;
  if (account !== undefined && account.balances.length > 0) {
    const { windows, baselines } = deepSeekBalanceWindows(
      account.balances,
      yield* baselineStore.load,
    );
    yield* baselineStore.save(baselines);
    usageLimits = makeUsageLimits({ checkedAt: account.checkedAt, windows });
  }
  return snapshot(settings, checkedAt, {
    installed: true,
    version,
    auth,
    ...probe,
    ...(usageLimits === undefined ? {} : { usageLimits }),
  });
});
