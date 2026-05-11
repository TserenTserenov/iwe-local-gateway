#!/usr/bin/env node
// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// MCP server (stdio transport) — Local MCP Gateway для multi-agent IWE.
// MVP: 3 tools + agent identity через env IWE_AGENT_ID.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LockManager } from "./lock-manager.js";

const AGENT_ID = process.env.IWE_AGENT_ID ?? "unknown-agent";
if (!process.env.IWE_AGENT_ID) {
  // All agents would share the same lock identity → multi-agent isolation breaks.
  process.stderr.write(
    `[iwe-local-gateway] WARNING: IWE_AGENT_ID not set — using "unknown-agent". ` +
      `Set IWE_AGENT_ID in .mcp.json env to enable per-agent lock isolation.\n`,
  );
}

const lockManager = new LockManager();

const acquireSchema = z.object({
  file: z.string().min(1, "file required"),
  ttl_seconds: z.number().int().positive().max(3600).optional(),
});

const releaseSchema = z.object({
  file: z.string().min(1, "file required"),
});

const server = new Server(
  { name: "iwe-local-gateway", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "gateway_status",
      description:
        "Возвращает текущее состояние Local MCP Gateway: список активных file-locks с держателями и временем acquire. Используется peer-агентом для проверки 'кто над чем работает' перед началом редактирования.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "acquire_file_lock",
      description:
        "Pessimistic-lock на запись файла. Возвращает success или collision с info о текущем держателе. TTL по умолчанию 300s (5 минут). Обязателен ПЕРЕД write_file в multi-agent сессии.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Абсолютный путь к файлу" },
          ttl_seconds: {
            type: "number",
            description: "TTL lock'а в секундах (default 300, max 3600)",
          },
        },
        required: ["file"],
        additionalProperties: false,
      },
    },
    {
      name: "release_file_lock",
      description:
        "Освобождение lock'а после write_file + commit. Можно вызвать только держателю; иначе not_held_by_caller.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Абсолютный путь к файлу" },
        },
        required: ["file"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "gateway_status") {
    const status = lockManager.status();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { agent_id: AGENT_ID, ...status },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === "acquire_file_lock") {
    const parsed = acquireSchema.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: "text", text: `invalid_arguments: ${parsed.error.message}` }],
      };
    }
    const ttlMs = (parsed.data.ttl_seconds ?? 300) * 1000;
    const result = lockManager.acquire(parsed.data.file, AGENT_ID, ttlMs);
    if (result.ok) {
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    // Collision is a normal business response (file is busy), not a protocol error.
    // isError: false lets the agent read the collision details and decide: backoff or switch file.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              status: "lock_collision",
              holder: result.holder.holder,
              expires_at: new Date(result.holder.expiresAt).toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === "release_file_lock") {
    const parsed = releaseSchema.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: "text", text: `invalid_arguments: ${parsed.error.message}` }],
      };
    }
    const result = lockManager.release(parsed.data.file, AGENT_ID);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `tool_not_available: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// stderr — наблюдаемость для пилота (stdout зарезервирован под JSON-RPC)
process.stderr.write(
  `[iwe-local-gateway] started agent_id=${AGENT_ID} pid=${process.pid}\n`,
);
