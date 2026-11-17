import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";

import { decodeDshTranscript, parseDshTranscript } from "./usage.ts";

const reply = (id: string, time: number, usage: Record<string, number>) =>
  JSON.stringify({
    type: "assistant/message",
    seq: 18,
    time,
    data: {
      turn: 1,
      message: {
        role: "assistant",
        source: { kind: "model", provider: "deepseek-account", model: "deepseek-flash" },
        id,
      },
      usage,
    },
  });

// dsh appends one zstd frame per write.
const frames = (...lines: string[]) =>
  Buffer.concat(lines.map((line) => NodeZlib.zstdCompressSync(Buffer.from(`${line}\n`))));

describe("dsh transcript usage", () => {
  it("reads every frame and maps cache counters", () => {
    const text = decodeDshTranscript(
      frames(
        JSON.stringify({ type: "session", id: "s1" }),
        reply("m1", 1_000, { inputTokens: 38_741, outputTokens: 55, cacheReadTokens: 0 }),
        JSON.stringify({ type: "turn/end" }),
        reply("m2", 2_000, {
          inputTokens: 146,
          outputTokens: 60,
          cacheReadTokens: 38_656,
          cacheWriteTokens: 5,
        }),
      ),
    );
    const records = parseDshTranscript(text, "s1");
    expect(records.map((record) => record.dedupeKey)).toEqual(["deepseek:s1:m1", "deepseek:s1:m2"]);
    expect(records[1]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
      timestampMs: 2_000,
      totals: {
        uncachedInputTokens: 146,
        cachedInputTokens: 38_656,
        cacheCreationTokens: 5,
        outputTokens: 60,
      },
    });
  });

  it("skips replies without usage and ignores damaged lines", () => {
    const text = `${reply("m1", 1, {})}\nnot json "assistant/message"\n`;
    expect(parseDshTranscript(text, "s1")).toEqual([]);
  });
});
