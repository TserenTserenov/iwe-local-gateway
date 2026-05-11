// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// Line-delimited JSON-RPC transport over Unix domain socket.
// Используется: daemon.ts (server-side per-connection) + proxy.ts (client-side).

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Socket } from "node:net";

export class SocketTransport implements Transport {
  private buf = "";
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onerror?: (err: Error) => void;
  onclose?: () => void;

  constructor(private readonly socket: Socket) {}

  async start(): Promise<void> {
    this.socket.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        } catch (e) {
          this.onerror?.(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    this.socket.on("error", (err: Error) => this.onerror?.(err));
    this.socket.on("close", () => this.onclose?.());
  }

  async send(msg: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(JSON.stringify(msg) + "\n", "utf8", (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}
