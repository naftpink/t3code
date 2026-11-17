import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";

import { DeepSeekSettings } from "../settings.ts";
import { DEEPSEEK_DRIVER_KIND, makeDeepSeekAcpRuntime } from "./acpSupport.ts";

const DEFAULT_DEEPSEEK_SETTINGS = Schema.decodeSync(DeepSeekSettings)({});

/** Capabilities stay at the shared ACP baseline until a live `dsh` session proves more. */
const DeepSeekProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
} satisfies OrchestrationV2ProviderCapabilities;

export interface DeepSeekAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DeepSeekSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
}

function makeDeepSeekAcpAdapterFlavor(options: DeepSeekAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: DEEPSEEK_DRIVER_KIND,
    runtimeHarness: "deepseek",
    capabilities: DeepSeekProviderCapabilitiesV2,
    makeRuntime: ({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }) =>
      makeDeepSeekAcpRuntime({
        ...input,
        deepSeekSettings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      }),
  };
}

export const makeDeepSeekAdapterV2 = Effect.fn("makeDeepSeekAdapterV2")(function* (
  options: DeepSeekAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeDeepSeekAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type DeepSeekAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeDeepSeekAdapterV2Driver: ProviderAdapterDriver<
  DeepSeekSettings,
  DeepSeekAdapterV2DriverEnv
> = {
  driverKind: DEEPSEEK_DRIVER_KIND,
  configSchema: DeepSeekSettings,
  defaultConfig: (): DeepSeekSettings => DEFAULT_DEEPSEEK_SETTINGS,
  create: Effect.fn("DeepSeekAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<DeepSeekSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeDeepSeekAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: DEEPSEEK_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DEEPSEEK_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the DeepSeek ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
