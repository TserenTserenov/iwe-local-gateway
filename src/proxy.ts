#!/usr/bin/env node
// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// stdio→socket proxy — что Claude Code запускает через .mcp.json.
// Маршрут: Claude Code ←stdio→ proxy ←socket→ daemon.
//
// Инжектирует IWE_AGENT_ID в MCP initialize (clientInfo.name),
// чтобы daemon идентифицировал агента для lock isolation.

import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH =
  process.env.IWE_GATEWAY_SOCKET ??
  path.join(os.homedir(), ".iwe", "gateway.sock");

const AGENT_ID = process.env.IWE_AGENT_ID ?? "unknown-agent";

if (!process.env.IWE_AGENT_ID) {
  process.stderr.write(
    `[iwe-gateway-proxy] WARNING: IWE_AGENT_ID not set — using "unknown-agent". ` +
      `Set IWE_AGENT_ID in .mcp.json env.\n`,
  );
}

const socket = net.createConnection(SOCKET_PATH);

socket.on("connect", () => {
  process.stderr.write(
    `[iwe-gateway-proxy] connected agent_id=${AGENT_ID} socket=${SOCKET_PATH}\n`,
  );
});

socket.on("error", (err) => {
  process.stderr.write(
    `[iwe-gateway-proxy] cannot connect to daemon at ${SOCKET_PATH}: ${err.message}\n` +
      `  Start daemon first: iwe-local-gateway-daemon &\n`,
  );
  process.exit(1);
});

// stdin → socket.
// Intercept initialize to inject IWE_AGENT_ID as clientInfo.name.
let stdinBuf = "";
process.stdin.on("data", (chunk: Buffer) => {
  stdinBuf += chunk.toString("utf8");
  let nl: number;
  while ((nl = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as {
        method?: string;
        params?: { clientInfo?: { name?: string } };
      };
      if (msg.method === "initialize" && msg.params?.clientInfo) {
        msg.params.clientInfo.name = AGENT_ID;
      }
      socket.write(JSON.stringify(msg) + "\n", "utf8");
    } catch {
      socket.write(line + "\n", "utf8");
    }
  }
});
process.stdin.on("end", () => socket.end());

// socket → stdout (passthrough).
socket.on("data", (chunk: Buffer) => process.stdout.write(chunk));
socket.on("close", () => process.exit(0));
socket.on("end", () => process.exit(0));
