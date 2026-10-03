// Actual MCP transports, isolated from the shared daemon, metrics and peer status.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SocketTransport } from "../dist/socket-transport.js";

const version = createRequire(import.meta.url)("../package.json").version;
const root = path.resolve(import.meta.dirname, "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "igw-"));
const clients = [];
let daemon;
let daemonExit;

function client(label) {
  const value = new Client({ name: `gateway-status-test-${label}-${randomUUID()}`, version: "1" });
  clients.push(value);
  return value;
}

async function call(value, name, args) {
  return value.callTool({ name, arguments: args }, undefined, { timeout: 3000 });
}

function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

async function verifyStatus(reader, writer, untouchedFiles = []) {
  assert.equal(reader.getServerVersion().version, version);
  const listed = await reader.listTools();
  assert.equal(listed.tools.length, 5);
  const schema = listed.tools.find((tool) => tool.name === "gateway_status").inputSchema;
  assert.equal(schema.properties.file.type, "string");
  assert.equal(schema.properties.file.minLength, 1);
  assert.deepEqual(schema.required ?? [], []);

  const selected = path.join(directory, "selected.ts");
  const other = path.join(directory, "unrelated.ts");
  const first = payload(await call(reader, "acquire_file_lock", { file: selected, ttl_seconds: 60 }));
  const second = payload(await call(writer, "acquire_file_lock", { file: other, ttl_seconds: 60 }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const before = payload(await call(reader, "gateway_status", {}));
  const diskBefore = await Promise.all(untouchedFiles.map((file) => fs.readFile(file, "utf8")));

  for (const alias of [selected, directory + "/nested/.././selected.ts/"]) {
    const status = payload(await call(reader, "gateway_status", { file: alias }));
    assert.equal(status.gateway_version, version);
    assert.deepEqual(status.locks, [first.lock]);
    assert.equal(JSON.stringify(status).includes(other), false);
  }
  assert.deepEqual(payload(await call(reader, "gateway_status", { file: path.join(directory, "absent.ts") })).locks, []);
  for (const args of [{ file: "" }, { file: 42 }, { file: null }]) {
    const rejected = await call(reader, "gateway_status", args);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /invalid_arguments/);
    assert.equal(JSON.stringify(rejected).includes(other), false);
  }

  const after = payload(await call(reader, "gateway_status", {}));
  assert.deepEqual(after.locks, before.locks);
  assert.deepEqual(Object.keys(after).sort(), ["agent_id", "gateway_version", "locks", "now"]);
  assert.deepEqual(await Promise.all(untouchedFiles.map((file) => fs.readFile(file, "utf8"))), diskBefore);
  assert.equal(payload(await call(reader, "release_file_lock", { file: selected })).released, true);
  assert.equal(payload(await call(writer, "release_file_lock", { file: other })).released, true);
}

async function startDaemon() {
  const socket = path.join(directory, "gateway.sock");
  const metrics = path.join(directory, "metrics.json");
  daemon = spawn(process.execPath, [path.join(root, "dist/daemon.js")], {
    env: { ...process.env, IWE_GATEWAY_SOCKET: socket, IWE_METRICS_PATH: metrics },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  daemon.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-8000); });
  daemonExit = once(daemon, "exit");
  const deadline = Date.now() + 3000;
  while (true) {
    if (daemon.exitCode !== null) throw new Error("Test daemon stopped: " + errors);
    try {
      await fs.stat(socket);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
  return { socket, files: [metrics, path.join(directory, "gateway-fencing.seq")] };
}

async function socketClient(socket, label) {
  const connection = net.createConnection(socket);
  await once(connection, "connect");
  const value = client(label);
  await value.connect(new SocketTransport(connection));
  return value;
}

try {
  const stdio = client("stdio");
  await stdio.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/server.js")],
    env: { ...process.env, IWE_AGENT_ID: `status-stdio-${randomUUID()}` },
    stderr: "pipe",
  }));
  await verifyStatus(stdio, stdio);
  await stdio.close();
  console.log("PASS stdio: schema, version, filtering, validation and unchanged locks");

  const fixture = await startDaemon();
  const reader = await socketClient(fixture.socket, "reader");
  const writer = await socketClient(fixture.socket, "writer");
  await verifyStatus(reader, writer, fixture.files);
  console.log("PASS isolated daemon: two holders, unchanged locks, fencing file and metrics");
} finally {
  await Promise.all(clients.map((value) => value.close()));
  if (daemon && daemon.exitCode === null) {
    daemon.kill();
    await daemonExit;
  }
  await fs.rm(directory, { recursive: true, force: true });
}
