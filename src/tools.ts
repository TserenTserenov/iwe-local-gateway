// see DP.SC.034, DP.IWE.005, WP-150 Ф6
// Shared tool definitions + registration — используется и daemon.ts (socket), и server.ts (stdio).

import { z } from "zod";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { LockManager } from "./lock-manager.js";

const acquireSchema = z.object({
  file: z.string().min(1, "file required"),
  ttl_seconds: z.number().int().positive().max(3600).optional(),
});

const releaseSchema = z.object({
  file: z.string().min(1, "file required"),
});

export const TOOL_LIST = [
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
] as const;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function text(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function err(obj: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  };
}

export function registerTools(
  server: Server,
  lockManager: LockManager,
  getAgentId: () => string,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_LIST,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const agentId = getAgentId();

    if (name === "gateway_status") {
      return text({ agent_id: agentId, ...lockManager.status() });
    }

    if (name === "acquire_file_lock") {
      const parsed = acquireSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      const result = lockManager.acquire(
        parsed.data.file,
        agentId,
        (parsed.data.ttl_seconds ?? 300) * 1000,
      );
      if (result.ok) return text(result);
      // Collision is a normal business response (file is busy), not a protocol error.
      return text({
        ok: false,
        status: "lock_collision",
        holder: result.holder.holder,
        expires_at: new Date(result.holder.expiresAt).toISOString(),
      });
    }

    if (name === "release_file_lock") {
      const parsed = releaseSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      const result = lockManager.release(parsed.data.file, agentId);
      if (!result.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      return text(result);
    }

    return err(`tool_not_available: ${name}`);
  });
}
