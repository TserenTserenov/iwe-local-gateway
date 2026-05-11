// Smoke-test MCP server через stdio: initialize → tools/list → acquire → status → release.
// Запуск: IWE_AGENT_ID=smoke node tests/smoke.mjs

import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const SERVER = resolve(import.meta.dirname, "..", "dist", "server.js");

const child = spawn("node", [SERVER], {
  env: { ...process.env, IWE_AGENT_ID: "smoke" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map(); // id → resolve

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) {
        pending.delete(msg.id);
        r(msg);
      }
    } catch (e) {
      console.error("[smoke] parse error:", line, e);
    }
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function assert(cond, msg) {
  if (!cond) {
    console.error("✗ FAIL:", msg);
    process.exit(1);
  } else {
    console.log("✓", msg);
  }
}

try {
  // 1. initialize
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0" },
  });
  assert(init.result?.serverInfo?.name === "iwe-local-gateway", "initialize: serverInfo.name");

  // 2. tools/list
  const tools = await call("tools/list", {});
  assert(tools.result?.tools?.length === 3, "tools/list: 3 tools");
  const names = tools.result.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify(["acquire_file_lock", "gateway_status", "release_file_lock"]),
    "tools/list: правильные имена",
  );

  // 3. gateway_status (пусто)
  const empty = await call("tools/call", { name: "gateway_status", arguments: {} });
  const emptyPayload = JSON.parse(empty.result.content[0].text);
  assert(emptyPayload.locks.length === 0, "gateway_status: пустой список locks");
  assert(emptyPayload.agent_id === "smoke", "gateway_status: agent_id=smoke");

  // 4. acquire
  const acq = await call("tools/call", {
    name: "acquire_file_lock",
    arguments: { file: "/tmp/smoke-test.txt", ttl_seconds: 60 },
  });
  const acqPayload = JSON.parse(acq.result.content[0].text);
  assert(acqPayload.ok === true, "acquire: ok");
  assert(acqPayload.lock.holder === "smoke", "acquire: holder=smoke");

  // 5. status (1 lock)
  const one = await call("tools/call", { name: "gateway_status", arguments: {} });
  const onePayload = JSON.parse(one.result.content[0].text);
  assert(onePayload.locks.length === 1, "status: 1 lock после acquire");

  // 6. release
  const rel = await call("tools/call", {
    name: "release_file_lock",
    arguments: { file: "/tmp/smoke-test.txt" },
  });
  const relPayload = JSON.parse(rel.result.content[0].text);
  assert(relPayload.released === true, "release: released=true");

  // 7. invalid arg
  const bad = await call("tools/call", {
    name: "acquire_file_lock",
    arguments: {},
  });
  assert(bad.result?.isError === true, "acquire: missing file → isError");

  console.log("\nALL SMOKE TESTS PASSED");
  child.kill();
  process.exit(0);
} catch (e) {
  console.error("[smoke] error:", e);
  child.kill();
  process.exit(1);
}
