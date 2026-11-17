import { TextGenerationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGenerationRuntime } from "@t3tools/provider-core/server/textGeneration";

import { DeepSeekSettings } from "../settings.ts";
import { DEEPSEEK_DRIVER_KIND } from "./acpSupport.ts";
import { type DeepSeekAdapterV2DriverEnv, makeDeepSeekAdapterV2Driver } from "./adapter.ts";
import { deepSeekUsageReader } from "./usage.ts";
import { makeDeepSeekBalanceBaselineStore } from "./balance.ts";
import { buildInitialDeepSeekProviderSnapshot, checkDeepSeekProviderStatus } from "./status.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);
// `dsh` is installed and updated through its own package manager, so T3 never updates it.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DEEPSEEK_DRIVER_KIND,
  packageName: null,
});

// See `supportsTextGeneration` in status.ts.
const unsupportedTextGeneration: ProviderTextGenerationRuntime = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "DeepSeek does not provide application text generation.",
      }),
    );
  return {
    supportedOperations: [],
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateKnowledgeCandidates: () => unsupported("generateKnowledgeCandidates"),
    generateConversationSummary: () => unsupported("generateConversationSummary"),
    generateModelEvaluation: () => unsupported("generateModelEvaluation"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
})();

export type DeepSeekDriverEnv =
  | DeepSeekAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost;

export const DeepSeekDriver: ProviderDriver<
  DeepSeekSettings,
  DeepSeekDriverEnv,
  FileSystem.FileSystem | Path.Path
> = {
  driverKind: DEEPSEEK_DRIVER_KIND,
  metadata: {
    displayName: "DeepSeek",
    supportsMultipleInstances: true,
  },
  configSchema: DeepSeekSettings,
  defaultConfig: (): DeepSeekSettings => decodeDeepSeekSettings({}),
  usage: deepSeekUsageReader,
  create: Effect.fn("DeepSeekDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const host = yield* ProviderHost.ProviderHost;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const baselineStore = yield* makeDeepSeekBalanceBaselineStore(
      path.join(
        host.paths.stateDir,
        "provider-auth",
        encodeURIComponent(instanceId),
        "deepseek-balance.json",
      ),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DEEPSEEK_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DEEPSEEK_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies DeepSeekSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DeepSeekSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialDeepSeekProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkDeepSeekProviderStatus(effectiveConfig, processEnv, baselineStore).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DEEPSEEK_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the DeepSeek provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* makeDeepSeekAdapterV2Driver
      .create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: effectiveConfig,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DEEPSEEK_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the DeepSeek orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: DEEPSEEK_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: () => snapshot.getSnapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
