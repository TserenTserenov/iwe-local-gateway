#!/usr/bin/env node
// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// Daemon: единственный процесс с одним LockManager, слушает на Unix socket.
// Все peer-агенты подключаются к этому процессу → lock state разделяется.
//
// Запуск:  iwe-local-gateway-daemon &
// Стоп:    kill $(cat ~/.iwe/gateway.pid)   или   SIGTERM / Ctrl-C
// Socket:  ~/.iwe/gateway.sock  (переопределяется через IWE_GATEWAY_SOCKET)

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LockManager } from "./lock-manager.js";
import { PeerStatusManager } from "./peer-status-manager.js";
import { metrics } from "./metrics-manager.js";
import { registerTools } from "./tools.js";
import { SocketTransport } from "./socket-transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const SOCKET_DIR = path.join(os.homedir(), ".iwe");
const SOCKET_PATH = process.env.IWE_GATEWAY_SOCKET ?? path.join(SOCKET_DIR, "gateway.sock");
const PID_PATH = path.join(SOCKET_DIR, "gateway.pid");

// Shared state across all connected agents.
const sharedLocks = new LockManager();
const sharedPeerStatus = new PeerStatusManager();

// Keep metrics.active_locks in sync when TTL silently drops a lock.
sharedLocks.onExpiry = (file) => metrics.recordRelease(file);

fs.mkdirSync(SOCKET_DIR, { recursive: true });

// Remove stale socket from previous run.
try { fs.unlinkSync(SOCKET_PATH); } catch { /* not present — fine */ }

let activeConnections = 0;

const netServer = net.createServer(async (socket) => {
  // Per-connection agent identity captured from MCP initialize clientInfo.name
  // (proxy.ts injects IWE_AGENT_ID there before forwarding to daemon).
  let agentId = "unknown-agent";

  const mcpServer = new Server(
    { name: "iwe-local-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(mcpServer, sharedLocks, () => agentId, sharedPeerStatus, metrics);

  const transport = new SocketTransport(socket);

  // Install intercept BEFORE connect() — no race window.
  // When SDK calls `transport.onmessage = handler` inside connect(), our setter
  // wraps the handler to peek at initialize and capture clientInfo.name as agentId.
  let _onmessage: typeof transport.onmessage;
  Object.defineProperty(transport, "onmessage", {
    get() { return _onmessage; },
    set(fn: typeof transport.onmessage) {
      _onmessage = fn
        ? <T extends JSONRPCMessage>(msg: T) => {
            const m = msg as { method?: string; params?: { clientInfo?: { name?: string } } };
            if (m.method === "initialize" && m.params?.clientInfo?.name) {
              agentId = m.params.clientInfo.name;
              process.stderr.write(`[iwe-local-gateway] agent connected: ${agentId}\n`);
            }
            fn(msg);
          }
        : fn;
    },
    configurable: true,
  });

  await mcpServer.connect(transport);

  activeConnections++;
  metrics.setActiveAgents(activeConnections);

  transport.onclose = () => {
    activeConnections = Math.max(0, activeConnections - 1);
    sharedPeerStatus.remove(agentId);
    metrics.setActiveAgents(activeConnections);
    process.stderr.write(`[iwe-local-gateway] agent disconnected: ${agentId}\n`);
  };
});

netServer.listen(SOCKET_PATH, () => {
  process.stderr.write(
    `[iwe-local-gateway] daemon started pid=${process.pid} socket=${SOCKET_PATH}\n`,
  );
});

fs.writeFileSync(PID_PATH, String(process.pid), "utf8");

function shutdown() {
  netServer.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
