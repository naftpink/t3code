// Thin client for a T3 server: scoped bearer token -> WebSocket ticket -> Effect RPC client.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";

// The RPC client type is huge; the bridge only uses a handful of methods, so keep it loose.
export type Rpc = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class T3 {
  private runtime: Promise<ManagedRuntime.ManagedRuntime<any, any>> | null = null;

  readonly origin: string;
  private readonly token: string;

  constructor(origin: string, token: string) {
    this.origin = origin;
    this.token = token;
  }

  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
    };
  }

  private async build() {
    const res = await fetch(`${this.origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`websocket ticket failed: HTTP ${res.status}`);
    const { ticket } = (await res.json()) as { ticket: string };
    const url = `${this.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`;
    const layerSocket = Socket.layerWebSocket(url).pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
    const layerProtocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(layerSocket),
      Layer.provide(RpcSerialization.layerJson),
    );
    return ManagedRuntime.make(layerProtocol);
  }

  private get rt() {
    this.runtime ??= this.build().catch((e) => {
      this.runtime = null;
      throw e;
    });
    return this.runtime;
  }

  /** Drop the connection so the next call opens a fresh one (new ticket). */
  async reset() {
    const old = this.runtime;
    this.runtime = null;
    try {
      await (await old)?.dispose();
    } catch {
      /* already dead */
    }
  }

  /** Run one RPC effect. Retries once on a fresh connection if the socket looks dead. */
  async call<A>(f: (client: Rpc) => Effect.Effect<A, any, any>): Promise<A> {
    for (let attempt = 0; ; attempt++) {
      try {
        const rt = await this.rt;
        return await rt.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* RpcClient.make(WsRpcGroup);
              return yield* f(client);
            }),
          ) as Effect.Effect<A, any, never>,
        );
      } catch (e) {
        if (attempt === 0 && /socket|closed|ECONN|WebSocket|fetch failed/i.test(String(e))) {
          await this.reset();
          continue;
        }
        throw e;
      }
    }
  }

  /** Create a project for agents to work in; returns its id. */
  async createProject(projectId: string, title: string, workspaceRoot: string) {
    const res = await fetch(`${this.origin}/api/projects/mutate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId,
        title,
        workspaceRoot,
      }),
    });
    if (!res.ok) throw new Error(`project.create failed: HTTP ${res.status} ${await res.text()}`);
  }

  async sleep(ms: number) {
    await sleep(ms);
  }
}
