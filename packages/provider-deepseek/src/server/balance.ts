import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

export const DeepSeekBalanceResponse = Schema.Struct({
  is_available: Schema.optional(Schema.Boolean),
  balance_infos: Schema.optional(
    Schema.Array(
      Schema.Struct({
        currency: Schema.String,
        total_balance: Schema.String,
        granted_balance: Schema.optional(Schema.String),
        topped_up_balance: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };

/** "Balance $12.34" or "Balance ¥110.00 · $2.00"; undefined when DeepSeek lists no balance. */
export function deepSeekBalanceLabel(response: typeof DeepSeekBalanceResponse.Type) {
  const parts = (response.balance_infos ?? []).flatMap((info) => {
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount)) return [];
    return [`${CURRENCY_SYMBOLS[info.currency] ?? `${info.currency} `}${amount.toFixed(2)}`];
  });
  if (parts.length === 0) return undefined;
  return `Balance ${parts.join(" · ")}`;
}

export interface DeepSeekBalance {
  readonly currency: string;
  readonly total: number;
}

export function deepSeekBalances(
  response: typeof DeepSeekBalanceResponse.Type,
): ReadonlyArray<DeepSeekBalance> {
  return (response.balance_infos ?? []).flatMap((info) => {
    const total = Number(info.total_balance);
    return Number.isFinite(total) && total >= 0 ? [{ currency: info.currency, total }] : [];
  });
}

const formatAmount = (currency: string, total: number) =>
  `${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${total.toFixed(2)}`;

/**
 * DeepSeek reports only what is left, so "used" is measured against the highest balance seen:
 * a top-up raises the baseline and the bar refills. The first reading has no history and shows
 * as full.
 */
export function deepSeekBalanceWindows(
  balances: ReadonlyArray<DeepSeekBalance>,
  previous: Readonly<Record<string, number>>,
): {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly baselines: Readonly<Record<string, number>>;
} {
  const baselines: Record<string, number> = { ...previous };
  const windows = balances.map(({ currency, total }): ServerProviderUsageWindow => {
    const baseline = Math.max(previous[currency] ?? 0, total);
    baselines[currency] = baseline;
    return {
      id: `balance-${currency.toLowerCase()}`,
      kind: "other",
      label: `Balance · ${formatAmount(currency, total)}`,
      usedPercent: baseline > 0 ? clampPercent((1 - total / baseline) * 100) : 0,
    };
  });
  return { windows, baselines };
}

/** Persists the highest balance seen per currency, so a restart does not reset the bar. */
export interface DeepSeekBalanceBaselineStore {
  readonly load: Effect.Effect<Readonly<Record<string, number>>>;
  readonly save: (baselines: Readonly<Record<string, number>>) => Effect.Effect<void>;
}

const BaselineRecord = Schema.Record(Schema.String, Schema.Number);

export const makeDeepSeekBalanceBaselineStore = Effect.fn("makeDeepSeekBalanceBaselineStore")(
  function* (
    file: string,
  ): Effect.fn.Return<DeepSeekBalanceBaselineStore, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      load: fileSystem.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(BaselineRecord))),
        Effect.orElseSucceed(() => ({})),
      ),
      save: (baselines) =>
        fileSystem
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(file, JSON.stringify(baselines))),
            Effect.ignore,
          ),
    };
  },
);

export interface DeepSeekAccount {
  readonly checkedAt: string;
  /** Undefined when no API key is set or the balance call failed. */
  readonly balanceLabel: string | undefined;
  readonly balances: ReadonlyArray<DeepSeekBalance>;
  /** False when DeepSeek reports the account cannot make API calls (no credit). */
  readonly available: boolean | undefined;
  readonly keyRejected: boolean;
}

/** Reads the account balance with `DEEPSEEK_API_KEY`; never fails. */
export const readDeepSeekAccount = Effect.fn("readDeepSeekAccount")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<DeepSeekAccount | undefined, never, HttpClient.HttpClient> {
  const key = environment.DEEPSEEK_API_KEY?.trim();
  if (!key) return undefined;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const client = yield* HttpClient.HttpClient;
  type FetchError = HttpClientError.HttpClientError | Schema.SchemaError;
  type Fetched =
    | { readonly keyRejected: true }
    | { readonly keyRejected: false; readonly body: typeof DeepSeekBalanceResponse.Type };
  const fetched: Effect.Effect<Fetched, FetchError> = client
    .execute(HttpClientRequest.get(DEEPSEEK_BALANCE_URL).pipe(HttpClientRequest.bearerToken(key)))
    .pipe(
      Effect.flatMap((response): Effect.Effect<Fetched, FetchError> =>
        response.status === 401
          ? Effect.succeed({ keyRejected: true })
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(DeepSeekBalanceResponse)),
              Effect.map((body): Fetched => ({ keyRejected: false, body })),
            ),
      ),
    );
  const result = yield* fetched.pipe(Effect.timeout("10 seconds"), Effect.option);
  if (Option.isNone(result)) {
    return {
      checkedAt,
      balanceLabel: undefined,
      balances: [],
      available: undefined,
      keyRejected: false,
    };
  }
  if (result.value.keyRejected) {
    return {
      checkedAt,
      balanceLabel: undefined,
      balances: [],
      available: undefined,
      keyRejected: true,
    };
  }
  return {
    checkedAt,
    balanceLabel: deepSeekBalanceLabel(result.value.body),
    balances: deepSeekBalances(result.value.body),
    available: result.value.body.is_available,
    keyRejected: false,
  };
});
