#!/usr/bin/env node
// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// MCP server (stdio transport) — Local MCP Gateway для multi-agent IWE.
// MVP: каждый агент запускает свою копию, lock state НЕ разделяется.
// Для общего lock state (multi-agent) → daemon.ts (socket transport).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LockManager } from "./lock-manager.js";
import { registerTools } from "./tools.js";

const AGENT_ID = process.env.IWE_AGENT_ID ?? "unknown-agent";
if (!process.env.IWE_AGENT_ID) {
  // All agents would share the same lock identity → multi-agent isolation breaks.
  process.stderr.write(
    `[iwe-local-gateway] WARNING: IWE_AGENT_ID not set — using "unknown-agent". ` +
      `Set IWE_AGENT_ID in .mcp.json env to enable per-agent lock isolation.\n`,
  );
}

const lockManager = new LockManager();
const server = new Server(
  { name: "iwe-local-gateway", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

registerTools(server, lockManager, () => AGENT_ID);

const transport = new StdioServerTransport();
await server.connect(transport);

// stderr — наблюдаемость для пилота (stdout зарезервирован под JSON-RPC)
process.stderr.write(
  `[iwe-local-gateway] started agent_id=${AGENT_ID} pid=${process.pid}\n`,
);
