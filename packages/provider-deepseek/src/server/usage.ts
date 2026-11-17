import * as NodeZlib from "node:zlib";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { DeepSeekSettings } from "../settings.ts";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE_NAME = "session.v4.jsonl.zstd";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `dsh` appends one zstd frame per write and Node's decoder stops after the first, so each frame
 * is decoded on its own. A frame start can also occur by chance inside compressed bytes; a piece
 * that fails to decode is retried with the next one joined onto it.
 */
export function decodeDshTranscript(bytes: Buffer): string {
  const starts: number[] = [];
  for (let at = bytes.indexOf(ZSTD_MAGIC); at !== -1; at = bytes.indexOf(ZSTD_MAGIC, at + 1)) {
    starts.push(at);
  }
  let text = "";
  for (let index = 0; index < starts.length; index += 1) {
    for (let last = index + 1; last <= starts.length; last += 1) {
      const end = last < starts.length ? starts[last]! : bytes.length;
      try {
        text += NodeZlib.zstdDecompressSync(bytes.subarray(starts[index]!, end)).toString("utf8");
        index = last - 1;
        break;
      } catch {
        // Not a frame boundary yet; widen the piece.
      }
    }
  }
  return text;
}

/** One record per model reply: `inputTokens` leaves out the cache read and write counters. */
export function parseDshTranscript(text: string, sessionId: string): readonly UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant/message"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = object(parsed);
    if (entry.type !== "assistant/message") continue;
    const data = object(entry.data);
    const message = object(data.message);
    const usage = object(data.usage);
    const model = object(message.source).model;
    const timestampMs = entry.time;
    if (typeof model !== "string" || model.length === 0) continue;
    if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) continue;
    const totals = {
      uncachedInputTokens: tokenCount(usage.inputTokens),
      cachedInputTokens: tokenCount(usage.cacheReadTokens),
      cacheCreationTokens: tokenCount(usage.cacheWriteTokens),
      outputTokens: tokenCount(usage.outputTokens),
      reasoningTokens: 0,
    };
    if (totalTokens(totals) === 0) continue;
    const messageId = typeof message.id === "string" ? message.id : null;
    records.push({
      provider: "deepseek",
      timestampMs,
      model,
      sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: messageId === null ? null : `deepseek:${sessionId}:${messageId}`,
    });
  }
  return records;
}

export const deepSeekUsageReader: ProviderUsageReader<
  DeepSeekSettings,
  FileSystem.FileSystem | Path.Path
> = {
  kind: "scan",
  provider: "deepseek",
  scan: Effect.fn("deepSeekUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    // Instances on one machine share dsh's home, so each directory is read once.
    const roots = new Set(
      instances.map((instance) =>
        path.resolve(
          expandHomePath(
            instance.environment.DSH_HOME?.trim() || path.join(homeDirectory, ".dsh"),
            homeDirectory,
          ),
          "sessions",
        ),
      ),
    );
    const scans: ProviderUsageScan[] = [];
    for (const dir of roots) {
      const projects = yield* fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed(() => null));
      if (projects === null) {
        scans.push({ dir, status: "missing", files: null });
        continue;
      }
      const files: { path: string; records: readonly UsageRecord[] }[] = [];
      let failed = false;
      for (const project of projects) {
        const sessions = yield* fileSystem
          .readDirectory(path.join(dir, project))
          .pipe(Effect.orElseSucceed(() => []));
        for (const session of sessions) {
          const file = path.join(dir, project, session, SESSION_FILE_NAME);
          const info = yield* Effect.option(fileSystem.stat(file));
          if (Option.isNone(info) || info.value.type !== "File") continue;
          const modified = Option.getOrNull(info.value.mtime)?.getTime();
          if (modified !== undefined && modified < windowStartMs) continue;
          const bytes = yield* fileSystem.readFile(file).pipe(Effect.orElseSucceed(() => null));
          if (bytes === null) {
            failed = true;
            continue;
          }
          files.push({
            path: file,
            records: parseDshTranscript(decodeDshTranscript(Buffer.from(bytes)), session).filter(
              (record) => record.timestampMs >= windowStartMs,
            ),
          });
        }
      }
      scans.push({ dir, status: failed ? "partial" : "ok", files });
    }
    return scans;
  }),
};
