// Smoke-test daemon: два агента, один lock, проверка shared state.
// Запуск: node tests/daemon-smoke.mjs

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";

const DAEMON = resolve(import.meta.dirname, "..", "dist", "daemon.js");
const SOCKET_PATH = `${tmpdir()}/iwe-gateway-smoke-${process.pid}.sock`;

// Start daemon pointing at temp socket
const daemon = spawn("node", [DAEMON], {
  env: { ...process.env, IWE_GATEWAY_SOCKET: SOCKET_PATH },
  stdio: ["ignore", "ignore", "inherit"],
});

// Wait for socket to appear
await new Promise((r) => setTimeout(r, 200));

function assert(cond, msg) {
  if (!cond) { console.error("✗ FAIL:", msg); daemon.kill(); process.exit(1); }
  else console.log("✓", msg);
}

// Create a socket-connected MCP client
function makeClient(agentId) {
  const socket = connect(SOCKET_PATH);
  let buf = "";
  const pending = new Map();
  let nextId = 1;

  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const r = pending.get(msg.id);
        if (r) { pending.delete(msg.id); r(msg); }
      } catch (e) {
        console.error("[smoke] parse:", e);
      }
    }
  });

  async function call(method, params) {
    const id = nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    socket.write(JSON.stringify(req) + "\n");
    return new Promise((r) => pending.set(id, r));
  }

  async function init() {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      // proxy.ts would normally override name; we do it here directly for smoke
      clientInfo: { name: agentId, version: "1.0" },
    });
  }

  return { call, init, close: () => socket.destroy() };
}

try {
  const claude = makeClient("claude-code");
  const kimikode = makeClient("kimikode");

  await new Promise((r) => setTimeout(r, 50)); // let connections settle

  await claude.init();
  await kimikode.init();

  // 1. Claude acquires a lock
  const acq = await claude.call("tools/call", {
    name: "acquire_file_lock",
    arguments: { file: "/tmp/daemon-smoke-test.ts", ttl_seconds: 60 },
  });
  const acqPayload = JSON.parse(acq.result.content[0].text);
  assert(acqPayload.ok === true, "claude acquires lock");
  assert(acqPayload.lock.holder === "claude-code", "holder = claude-code");

  // 2. Kimikode sees collision (different process, same daemon → shared state!)
  const collision = await kimikode.call("tools/call", {
    name: "acquire_file_lock",
    arguments: { file: "/tmp/daemon-smoke-test.ts", ttl_seconds: 60 },
  });
  const collPayload = JSON.parse(collision.result.content[0].text);
  assert(collPayload.ok === false, "kimikode sees collision");
  assert(collPayload.status === "lock_collision", "status = lock_collision");
  assert(collPayload.holder === "claude-code", "collision holder = claude-code");
  assert(!collision.result.isError, "collision is NOT isError (normal business response)");

  // 3. Claude releases — kimikode can acquire
  await claude.call("tools/call", {
    name: "release_file_lock",
    arguments: { file: "/tmp/daemon-smoke-test.ts" },
  });
  const acq2 = await kimikode.call("tools/call", {
    name: "acquire_file_lock",
    arguments: { file: "/tmp/daemon-smoke-test.ts", ttl_seconds: 60 },
  });
  const acq2Payload = JSON.parse(acq2.result.content[0].text);
  assert(acq2Payload.ok === true, "kimikode acquires after claude releases");

  // 4. Claude's gateway_status shows kimikode's lock
  const status = await claude.call("tools/call", {
    name: "gateway_status",
    arguments: {},
  });
  const statusPayload = JSON.parse(status.result.content[0].text);
  assert(statusPayload.locks.length === 1, "status: 1 lock visible to claude");
  assert(statusPayload.locks[0].holder === "kimikode", "lock holder = kimikode");

  // 5. Peer status: claude announces focus
  const upd = await claude.call("tools/call", {
    name: "update_peer_status",
    arguments: { focus: "src/auth.ts", intent: "рефакторинг OAuth flow", awaiting_decision: false },
  });
  const updPayload = JSON.parse(upd.result.content[0].text);
  assert(updPayload.ok === true, "update_peer_status: ok");
  assert(updPayload.status.agent_id === "claude-code", "status.agent_id = claude-code");

  // 6. Kimikode sees claude's status
  const listRes = await kimikode.call("tools/call", {
    name: "list_peer_statuses",
    arguments: {},
  });
  const listPayload = JSON.parse(listRes.result.content[0].text);
  assert(listPayload.statuses.length === 1, "list_peer_statuses: 1 status");
  assert(listPayload.statuses[0].focus === "src/auth.ts", "focus = src/auth.ts");

  console.log("\nALL DAEMON SMOKE TESTS PASSED — shared lock state + peer status works ✅");

  claude.close();
  kimikode.close();
  daemon.kill();
  process.exit(0);
} catch (e) {
  console.error("[daemon-smoke] error:", e);
  daemon.kill();
  process.exit(1);
}
