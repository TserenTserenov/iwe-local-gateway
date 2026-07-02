// see DP.SC.034, DP.SC.035, DP.IWE.005, DP.SC.187, WP-150 Ф6+Ф7, WP-149 Ф-local-assembly-delivery
// Shared tool definitions + registration — используется и daemon.ts (socket), и server.ts (stdio).

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createRequire } from "node:module";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { LockManager } from "./lock-manager.js";
import type { PeerStatusManager } from "./peer-status-manager.js";
import type { metrics as MetricsAPI } from "./metrics-manager.js";

// Both MCP initialization and status identify the installed package version.
export const GATEWAY_VERSION: string = createRequire(import.meta.url)("../package.json").version;

const gatewayStatusSchema = z.object({
  file: z.string().min(1, "file must not be empty").optional(),
}).strict();

const acquireSchema = z.object({
  file: z.string().min(1, "file required"),
  ttl_seconds: z.number().int().positive().max(3600).optional(),
});

const releaseSchema = z.object({
  file: z.string().min(1, "file required"),
});

const updateStatusSchema = z.object({
  focus: z.string().min(1, "focus required"),
  intent: z.string().min(1, "intent required"),
  awaiting_decision: z.boolean().optional(),
});

const renderGuideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  output_path: z.string().optional(),
  lang: z.enum(["ru", "en"]).optional().default("ru"),
});

export const TOOL_LIST = [
  {
    name: "gateway_status",
    description:
      "Возвращает активные file-locks с держателями, TTL и fencingToken. Необязательный file ограничивает ответ одним нормализованным путём: locks содержит 0 или 1 запись, без приобретения или продления lock. Без file возвращается общий список.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", minLength: 1, description: "Путь как в acquire_file_lock; поддерживает ~/ и нормализацию . / .." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "acquire_file_lock",
    description:
      "Pessimistic-lock на запись файла. Возвращает success (с монотонным fencing_token в lock.fencingToken — сохрани и сверь с gateway_status перед финальной записью: другой токен на том же файле = твоя аренда протухла и перевыдана, перечитай файл и возьми lock заново) или collision с info о текущем держателе. TTL по умолчанию 300s (5 минут). Обязателен ПЕРЕД write_file в multi-agent сессии.",
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
  {
    name: "update_peer_status",
    description:
      "Объявить статус агента: что делаю (focus), почему (intent), заблокирован ли. Другие peer-агенты видят эту информацию через list_peer_statuses — координация без lock. Вызывать при начале задачи и по завершении.",
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "Что делает агент (файл или задача)" },
        intent: { type: "string", description: "Контекст: зачем, для какой цели" },
        awaiting_decision: {
          type: "boolean",
          description: "true если агент заблокирован и ждёт решения пилота",
        },
      },
      required: ["focus", "intent"],
      additionalProperties: false,
    },
  },
  {
    name: "list_peer_statuses",
    description:
      "Список статусов всех peer-агентов: кто над чем работает, кто заблокирован. Вызывать перед началом работы для проверки намерений других агентов (coordination без lock).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "render_personal_guide",
    description:
      "Запускает сборку персонального руководства пилота (render-pilot-guides.py --daily). Identity пилота берётся из env PILOT_GITHUB_OWNER. Возвращает статус, путь к файлу руководства и список предупреждений. Реализует DP.SC.187. WP-456 Ф2: pass lang='en' for English draft probe; default is ru.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Дата руководства в формате YYYY-MM-DD" },
        output_path: { type: "string", description: "Зарезервировано для будущей локальной записи (Ф2); в Ф1 игнорируется" },
        lang: { type: "string", enum: ["ru", "en"], description: "Язык руководства (default: ru)" },
      },
      required: ["date"],
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
  peerStatus?: PeerStatusManager,
  gatewayMetrics?: typeof MetricsAPI,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_LIST,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const agentId = getAgentId();

    if (name === "gateway_status") {
      const parsed = gatewayStatusSchema.safeParse(args === undefined ? {} : args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      return text({ agent_id: agentId, gateway_version: GATEWAY_VERSION, ...lockManager.status(parsed.data.file) });
    }

    if (name === "acquire_file_lock") {
      const parsed = acquireSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      const result = lockManager.acquire(
        parsed.data.file,
        agentId,
        (parsed.data.ttl_seconds ?? 300) * 1000,
      );
      if (result.ok) {
        gatewayMetrics?.recordAcquire(result.lock.file);
        return text(result);
      }
      // Collision is a normal business response (file is busy), not a protocol error.
      gatewayMetrics?.recordCollision();
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
      if (result.released) gatewayMetrics?.recordRelease(parsed.data.file);
      return text(result);
    }

    if (name === "update_peer_status") {
      if (!peerStatus) return err("peer_status_not_available: run in daemon mode");
      const parsed = updateStatusSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);
      const status = peerStatus.update(
        agentId,
        parsed.data.focus,
        parsed.data.intent,
        parsed.data.awaiting_decision ?? false,
      );
      return text({ ok: true, status });
    }

    if (name === "list_peer_statuses") {
      if (!peerStatus) return err("peer_status_not_available: run in daemon mode");
      return text({ statuses: peerStatus.list() });
    }

    if (name === "render_personal_guide") {
      const parsed = renderGuideSchema.safeParse(args);
      if (!parsed.success) return err(`invalid_arguments: ${parsed.error.message}`);

      const pilotOwner = process.env.PILOT_GITHUB_OWNER ?? process.env.GITHUB_OWNER;
      if (!pilotOwner) {
        return err("render_not_configured: set PILOT_GITHUB_OWNER in gateway env");
      }

      const iweHome = process.env.IWE_HOME ?? path.join(os.homedir(), "IWE");
      const scriptPath =
        process.env.IWE_RENDER_SCRIPT_PATH ??
        path.join(iweHome, "DS-autonomous-agents/scripts/render-pilot-guides.py");

      const spawnArgs = [
        scriptPath,
        "--daily",
        `--user=${pilotOwner}`,
        `--date=${parsed.data.date}`,
        `--lang=${parsed.data.lang}`,
      ];

      const result = spawnSync("python3", spawnArgs, {
        timeout: 90_000,
        encoding: "utf8",
        env: process.env,
      });

      const warnings: string[] = [];
      const stderr = result.stderr ?? "";

      if (result.error) {
        return err(`render_spawn_error: ${result.error.message}`);
      }

      if (result.status !== 0) {
        const lastLines = stderr.split("\n").filter(Boolean).slice(-5).join("\n");
        return text({ status: "fail", guide_path: null, warnings: [lastLines] });
      }

      if (stderr.includes("YAML fallback")) {
        warnings.push("knowledge DB unavailable — YAML fallback used for sources");
      }
      if (stderr.includes("FAIL=1") || stderr.includes("FAIL=true")) {
        return text({ status: "fail", guide_path: null, warnings });
      }

      const guidePath = `guide/${parsed.data.date}.md`;
      const status = warnings.length > 0 ? "warn" : "ok";
      return text({ status, guide_path: guidePath, warnings });
    }

    return err(`tool_not_available: ${name}`);
  });
}
