/**
 * DeepSeek instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * The API key is not a setting: set `DEEPSEEK_API_KEY` in the instance environment.
 *
 * @module provider-deepseek/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DeepSeekSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("dsh").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Path to the DeepSeek Harness (`dsh`) binary. Set DEEPSEEK_API_KEY in the instance environment to show your balance.",
        providerSettingsForm: { placeholder: "dsh", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type DeepSeekSettings = typeof DeepSeekSettings.Type;
