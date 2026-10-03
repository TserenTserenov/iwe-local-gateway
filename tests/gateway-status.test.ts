import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LockManager } from "../src/lock-manager.js";
import { GATEWAY_VERSION, registerTools } from "../src/tools.js";

describe("gateway_status MCP contract", () => {
  let client: Client;
  let server: Server;
  let locks: LockManager;

  beforeEach(async () => {
    locks = new LockManager();
    locks.acquire("/tmp/selected.ts", "writer-a");
    locks.acquire("/tmp/unrelated.ts", "writer-b");
    server = new Server({ name: "test-gateway", version: GATEWAY_VERSION }, { capabilities: { tools: {} } });
    registerTools(server, locks, () => "reader");
    client = new Client({ name: "reader", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  async function status(args?: Record<string, unknown>) {
    return client.callTool({ name: "gateway_status", ...(args === undefined ? {} : { arguments: args }) });
  }

  function payload(result: Awaited<ReturnType<typeof status>>) {
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    return JSON.parse(content[0].text);
  }

  it("advertises the optional filter and a package-derived version without adding a tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
    const schema = tools.find((tool) => tool.name === "gateway_status")!.inputSchema;
    expect(schema.properties).toEqual({
      file: { type: "string", minLength: 1, description: expect.any(String) },
    });
    expect(schema.required ?? []).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
    expect(GATEWAY_VERSION).toBe(createRequire(import.meta.url)("../package.json").version);
    expect(client.getServerVersion()?.version).toBe(GATEWAY_VERSION);
  });

  it("keeps the default fields and all locks when arguments are omitted or empty", async () => {
    for (const args of [undefined, {}]) {
      const result = await status(args);
      expect(result.isError).not.toBe(true);
      const data = payload(result);
      expect(Object.keys(data).sort()).toEqual(["agent_id", "gateway_version", "locks", "now"]);
      expect(data.agent_id).toBe("reader");
      expect(data.gateway_version).toBe(GATEWAY_VERSION);
      expect(data.locks).toEqual(locks.status().locks);
      expect(Number.isNaN(Date.parse(data.now))).toBe(false);
    }
  });

  it("filters on the server and does not acquire, release or renew locks", async () => {
    const before = structuredClone(locks.status().locks);
    const acquire = vi.spyOn(locks, "acquire");
    const release = vi.spyOn(locks, "release");
    const result = await status({ file: "/tmp/sub/../selected.ts" });
    expect(result.isError).not.toBe(true);
    expect(payload(result).locks).toEqual([before[0]]);
    expect(JSON.stringify(result)).not.toContain("unrelated");
    expect(JSON.stringify(result)).not.toContain("writer-b");
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(locks.status().locks).toEqual(before);
    expect(payload(await status({ file: "/tmp/absent.ts" })).locks).toEqual([]);
  });

  it.each([{ file: "" }, { file: 123 }, { file: null }, { file: [] }, { filename: "/tmp/selected.ts" }])(
    "rejects an invalid filter without falling back to a full registry: %j",
    async (args) => {
      const lookup = vi.spyOn(locks, "status");
      const result = await status(args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("invalid_arguments");
      expect(JSON.stringify(result)).not.toContain("writer-a");
      expect(JSON.stringify(result)).not.toContain("writer-b");
      expect(lookup).not.toHaveBeenCalled();
    },
  );
});
