import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const FORK_ONLY = new Set([
  "ProjectKnowledge",
  "ProjectKnowledgeDeliveries",
  "ProjectKnowledgeHistory",
  "ProjectCodeFileHistory",
  "ProjectKnowledgeAssistedRuns",
  "ConversationSummaries",
  "ProjectKnowledgeSearchReceiptExpiry",
  "ProjectLoomTimeIndexes",
  "ProjectCodeFileHistoryPages",
  "ProjectLoomBoundedReads",
  "ProjectIntelligenceAndCrossEnvironment",
  "ProjectKnowledgeMessageDeliveries",
  "ModelEvaluations",
  "DropProjectLoomIndexes",
  "ProjectKnowledgeSavedLifecycle",
  "ProjectKnowledgeLearningQueue",
  "ConversationSummaryPosition",
  "RetireInferenceRouteInstances",
  "ProjectKnowledgeViews",
  "RepairSerializedModelSelectionOptions",
  "RepairSubagentGroups",
  "ProjectKnowledgeRecallIndex",
]);

describe("official migration history upgrade", () => {
  it.effect("renumbers a database written without the fork's migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      const official = migrationEntries.filter(([id, name]) => id >= 68 && !FORK_ONLY.has(name));
      for (const [, , migration] of official) yield* migration;
      const names = [
        "ShellStopRequestIndex",
        "ThreadMessageSearch",
        "PeerLinks",
        "PeerLinkFence",
        "WaitingLinkRequestIndex",
        ...official.slice(2).map(([, name]) => name),
      ];
      for (const [index, name] of names.entries()) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${68 + index}, ${name})
        `;
      }

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([, name]) => name),
        migrationEntries
          .filter(([id, name]) => id >= 68 && FORK_ONLY.has(name))
          .map(([, name]) => name),
      );
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name]),
        migrationManifest.filter(([id]) => id >= 68).map(([id, name]) => [id, name]),
      );
      const peers = yield* sql`PRAGMA table_info(peer_environment_links)`;
      assert.isTrue(peers.length > 0);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
