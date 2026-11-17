import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// Ids 68–95 as recorded by builds without this fork's project-knowledge migrations.
const OFFICIAL_HISTORY = [
  "ShellStopRequestIndex",
  "ThreadMessageSearch",
  "PeerLinks",
  "PeerLinkFence",
  "WaitingLinkRequestIndex",
  "ActiveTurnItemIndexes",
  "ExcludeAttachmentPlaceholdersFromSearch",
  "SubagentDeliveryState",
  "ProjectionProjectsPinArchive",
  "RepairBooleanSettledOverride",
  "DropOrchestrationEventCorrelationIndex",
  "DelegatedRecoveryIndexes",
  "ScheduledTaskThreadMode",
  "ProjectionMessageSearchText",
  "TurnItemConversationIndex",
  "CommandReadIndexes",
  "LastExecutedRunIndex",
  "TurnItemCounts",
  "QueuedTurnInputIndex",
  "ProjectionProjectsCustomTitle",
  "TurnItemTypeStatusIndex",
  "ShellThreadReadIndexes",
  "AuthConnectDevices",
  "AuthConnectDeniedRequests",
  "QueuedTurnInputIndexJsonValid",
  "ProviderTurnAttemptIndex",
  "TurnItemMessageOrdinalIndex",
  "TurnItemInlineWorkOutput",
] as const;
const FIRST_OFFICIAL_ID = 68;

// The migrator trusts ids, so a database from such a build is renumbered by name: migrations it
// already ran are kept, the rest run in manifest order. Fork migration 80 creates the peer-link
// schema idempotently, which covers PeerLinks, PeerLinkFence and WaitingLinkRequestIndex.
export const reconcileOfficialMigrationHistory = Effect.fn("reconcileOfficialMigrationHistory")(
  function* <E>(
    entries: ReadonlyArray<
      readonly [number, string, Effect.Effect<unknown, E, SqlClient.SqlClient>]
    >,
  ) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return [];
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
          readonly created_at: string;
        }>`
          SELECT migration_id, name, created_at FROM effect_sql_migrations
          WHERE migration_id >= ${FIRST_OFFICIAL_ID} ORDER BY migration_id
        `;
        const isOfficial =
          history.length > 0 &&
          history[0]?.name === OFFICIAL_HISTORY[0] &&
          history.every((row, index) => {
            return (
              row.migration_id === FIRST_OFFICIAL_ID + index && row.name === OFFICIAL_HISTORY[index]
            );
          });
        if (!isOfficial) return [];

        const applied = new Map(history.map((row) => [row.name, row.created_at]));
        const executed: Array<readonly [number, string]> = [];
        const ledger: Array<readonly [number, string, string | undefined]> = [];
        for (const [id, name, migration] of entries) {
          if (id < FIRST_OFFICIAL_ID) continue;
          if (!applied.has(name)) {
            yield* migration.pipe(
              Effect.mapError(
                (cause) =>
                  new Migrator.MigrationError({
                    kind: "Failed",
                    message: `Failed to upgrade ${id}_${name}: ${String(cause)}`,
                  }),
              ),
            );
            executed.push([id, name]);
          }
          ledger.push([id, name, applied.get(name)]);
        }
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${FIRST_OFFICIAL_ID}`;
        for (const [id, name, createdAt] of ledger) {
          yield* createdAt === undefined
            ? sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`
            : sql`
                INSERT INTO effect_sql_migrations (migration_id, name, created_at)
                VALUES (${id}, ${name}, ${createdAt})
              `;
        }
        return executed;
      }),
    );
  },
);
