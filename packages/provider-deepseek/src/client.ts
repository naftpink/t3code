/**
 * DeepSeek's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-deepseek/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { DeepSeekSettings } from "./settings.ts";

export const deepSeekClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("deepseek"),
  label: "DeepSeek",
  modelFamilies: ["deepseek-"],
  featured: false,
  settingsSchema: DeepSeekSettings,
  // Placeholder ring glyph; swap for the official mark.
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#4D6BFE", dark: "#7F95FF" },
    paths: [
      {
        d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z",
      },
    ],
  },
});
