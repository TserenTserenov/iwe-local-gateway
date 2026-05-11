# iwe-local-gateway

Local MCP Gateway для multi-agent IWE сессии в VS Code.

**Pack:** [DP.SC.034](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.034-local-mcp-gateway.md) · [DP.IWE.005](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.IWE.005-local-gateway.md)

**Не путать с [gateway-mcp](../gateway-mcp/)** (Aisystant MCP cloud, `mcp.aisystant.com`, multi-tenant HTTPS) — это **локальный** in-process слой для координации peer-агентов в одной VS Code сессии. См. различение в `~/IWE/.claude/rules/distinctions.md`.

## Что делает

Координирует write-операции между peer-агентами (Claude Code, Kimikode и др.), работающими над одним workspace:

- `gateway_status` — список активных file-locks с держателями
- `acquire_file_lock` — pessimistic-lock на файл (TTL 5 мин по умолчанию)
- `release_file_lock` — освобождение lock'а после commit

## MVP scope

- ✅ stdio transport (MCP standard)
- ✅ In-memory lock manager с TTL auto-expiry
- ✅ Path canonicalization (`~/foo` ≡ `/Users/x/foo`)
- ✅ Agent identity через env `IWE_AGENT_ID`
- ⏳ Unix socket transport — отдельная итерация (см. DP.IWE.005 §9 Q1)
- ⏳ Tool-allowlist per agent — отдельная итерация (нужен upstream-routing)
- ⏳ Upstream-proxy к Aisystant MCP — отдельная итерация

## Установка

```bash
cd ~/IWE/DS-MCP/local-gateway
npm install
npm run build
npm test
```

## Подключение к Claude Code

В `.mcp.json` рабочего workspace:

```json
{
  "mcpServers": {
    "iwe-local-gateway": {
      "command": "node",
      "args": ["/Users/tserentserenov/IWE/DS-MCP/local-gateway/dist/server.js"],
      "env": {
        "IWE_AGENT_ID": "claude-code"
      }
    }
  }
}
```

Для Kimikode — отдельный config с `IWE_AGENT_ID: "kimikode"`.

> **Внимание (MVP-ограничение stdio):** каждый peer-агент при stdio-транспорте запускает **свою** копию процесса Gateway, и lock-состояние не разделяется между копиями. Это значит, что в MVP-stdio координация работает **только в пределах одной IDE-сессии одного агента** (полезно как scaffold + тесты), но не разделяет lock'и между Claude и Kimikode. Для реального multi-agent — нужен Unix socket transport (см. DP.IWE.005 §9 Q1). MVP — это первый кирпич; следующий шаг — socket. Пользователь предупреждён, не путать с продакшеном.

## Пример использования (после установки socket-режима — следующая итерация)

```
Claude → acquire_file_lock({file: "src/auth.py"})  → ok
Claude → write src/auth.py                          → ok
Claude → release_file_lock({file: "src/auth.py"})  → ok

Kimikode → acquire_file_lock({file: "src/auth.py"}) → ok (теперь свободен)
```

При collision (попытка acquire когда другой держит):

```
Kimikode → acquire_file_lock({file: "src/auth.py"})
  → error: lock_collision, holder: claude, acquired_at: 2026-05-11T16:42:00Z
  → решение: backoff polling ИЛИ переключение на другой файл (см. DP.SC.035 / DP.ROLE.039)
```

## Тесты

```bash
npm test
```

Покрытие: 9 тестов lock-manager.ts (acquire/release happy + collisions + TTL expiry + path canonicalization).

## Связанные документы

- [DP.SC.034](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.034-local-mcp-gateway.md) — обещание Local Gateway
- [DP.SC.035](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.035-peer-agent-choreography.md) — peer-agent choreography поверх Gateway
- [DP.IWE.005](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.IWE.005-local-gateway.md) — Pack-сущность
- [DP.ROLE.039](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.ROLE.039-peer-agent.md) — Peer Agent роль
