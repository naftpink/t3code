import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { deepSeekBalanceLabel, deepSeekBalanceWindows, readDeepSeekAccount } from "./balance.ts";

const clientReturning = (status: number, body: unknown) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
      ),
    ),
  );

describe("deepSeekBalanceLabel", () => {
  it("formats each currency and skips unparsable amounts", () => {
    expect(
      deepSeekBalanceLabel({
        balance_infos: [
          { currency: "CNY", total_balance: "110.5" },
          { currency: "USD", total_balance: "2" },
          { currency: "EUR", total_balance: "n/a" },
        ],
      }),
    ).toBe("Balance ¥110.50 · $2.00");
    expect(deepSeekBalanceLabel({ balance_infos: [] })).toBeUndefined();
  });
});

describe("readDeepSeekAccount", () => {
  it.effect("reads nothing without an API key", () =>
    Effect.gen(function* () {
      expect(yield* readDeepSeekAccount({})).toBeUndefined();
    }).pipe(Effect.provide(clientReturning(200, {}))),
  );

  it.effect("reports the balance and availability", () =>
    Effect.gen(function* () {
      const account = yield* readDeepSeekAccount({ DEEPSEEK_API_KEY: "sk-test" });
      expect(account).toMatchObject({
        balanceLabel: "Balance $4.20",
        available: true,
        keyRejected: false,
      });
    }).pipe(
      Effect.provide(
        clientReturning(200, {
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: "4.20" }],
        }),
      ),
    ),
  );

  it.effect("flags a rejected key and tolerates server errors", () =>
    Effect.gen(function* () {
      const rejected = yield* readDeepSeekAccount({ DEEPSEEK_API_KEY: "bad" }).pipe(
        Effect.provide(clientReturning(401, {})),
      );
      expect(rejected?.keyRejected).toBe(true);
      const failed = yield* readDeepSeekAccount({ DEEPSEEK_API_KEY: "sk" }).pipe(
        Effect.provide(clientReturning(500, {})),
      );
      expect(failed).toMatchObject({ balanceLabel: undefined, keyRejected: false });
    }),
  );
});

describe("deepSeekBalanceWindows", () => {
  it("measures use against the highest balance seen and refills on a top-up", () => {
    const first = deepSeekBalanceWindows([{ currency: "USD", total: 10 }], {});
    expect(first.windows[0]).toMatchObject({ id: "balance-usd", usedPercent: 0 });
    expect(first.windows[0]?.label).toBe("Balance · $10.00");

    const spent = deepSeekBalanceWindows([{ currency: "USD", total: 2.5 }], first.baselines);
    expect(spent.windows[0]?.usedPercent).toBe(75);
    expect(spent.baselines).toEqual({ USD: 10 });

    const toppedUp = deepSeekBalanceWindows([{ currency: "USD", total: 20 }], spent.baselines);
    expect(toppedUp.windows[0]?.usedPercent).toBe(0);
    expect(toppedUp.baselines).toEqual({ USD: 20 });
  });

  it("keeps each currency on its own baseline and shows an empty balance as fully used", () => {
    const result = deepSeekBalanceWindows(
      [
        { currency: "CNY", total: 0 },
        { currency: "USD", total: 1 },
      ],
      { CNY: 50 },
    );
    expect(result.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["balance-cny", 100],
      ["balance-usd", 0],
    ]);
  });
});
