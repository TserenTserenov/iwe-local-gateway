# iwe-local-gateway

Local MCP Gateway для multi-agent IWE сессии в VS Code.

**Pack:** [DP.SC.034](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.034-local-mcp-gateway.md) · [DP.IWE.005](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.IWE.005-local-gateway.md)

**Не путать с [gateway-mcp](../gateway-mcp/)** (Aisystant MCP cloud, `mcp.aisystant.com`, multi-tenant HTTPS) — это **локальный** in-process слой для координации peer-агентов в одной VS Code сессии. См. различение в `~/IWE/.claude/rules/distinctions.md`.

## Что делает

Координирует write-операции между peer-агентами (Claude Code, Kimikode и др.), работающими над одним workspace:

- `gateway_status` — список активных file-locks; необязательный `file` возвращает состояние одного пути
- `acquire_file_lock` — pessimistic-lock на файл (TTL 5 мин по умолчанию)
- `release_file_lock` — освобождение lock'а после commit

## Статус реализации

- ✅ **Unix socket daemon** — единственный процесс, shared lock state (реальный multi-agent)
- ✅ **stdio proxy** — мост stdio↔socket для подключения Claude Code / Kimikode
- ✅ **stdio server** — режим MVP для тестов и single-agent
- ✅ In-memory lock manager с TTL auto-expiry
- ✅ Path canonicalization (`~/foo` ≡ `/Users/x/foo`)
- ✅ Agent identity через env `IWE_AGENT_ID` (daemon capture + proxy inject)
- ⏳ Tool-allowlist per agent — следующая итерация
- ⏳ Upstream-proxy к Aisystant MCP — следующая итерация

## Установка

```bash
cd ~/IWE/DS-MCP/local-gateway
npm install
npm run build
npm test
```

## Подключение к Claude Code (daemon-режим)

**Шаг 1.** Запустить daemon один раз за VS Code сессию:

```bash
node /Users/tserentserenov/IWE/DS-MCP/local-gateway/dist/daemon.js &
# или npm run daemon  (из директории local-gateway)
```

**Шаг 2.** В `.mcp.json` рабочего workspace для каждого агента — proxy:

```json
{
  "mcpServers": {
    "iwe-local-gateway": {
      "command": "node",
      "args": ["/Users/tserentserenov/IWE/DS-MCP/local-gateway/dist/proxy.js"],
      "env": {
        "IWE_AGENT_ID": "claude-code"
      }
    }
  }
}
```

Для Kimikode — отдельный `.mcp.json` с `"IWE_AGENT_ID": "kimikode"`.  
Оба подключаются к одному daemon → один LockManager → shared lock state.

> **Stdio-режим (MVP, legacy):** `dist/server.js` — каждый агент в отдельном процессе без разделения state. Полезен для тестов и одиночного агента.

## Пример использования

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
npm test                      # unit + in-memory MCP contract tests (Vitest)
npm run test:mcp              # build + isolated stdio/socket status contract tests
node tests/smoke.mjs          # MCP smoke (stdio, 10 checks)
```

Vitest проверяет lock-manager, пути демона, socket transport и MCP-контракт.
`test:mcp` дополнительно запускает собранные stdio server и отдельный daemon
с двумя клиентами.

### Адресная проверка блокировки

```json
{"file": "/absolute/path/to/file"}
```

Вызов `gateway_status` с этим аргументом возвращает прежние поля
`agent_id`, `gateway_version`, `locks`, `now`. В `locks` будет одна запись
или пустой массив, если активной блокировки нет. Фильтр применяется на сервере
до сериализации. Путь нормализуется так же, как в acquire/release: `~/`,
`.`, `..` и завершающий слеш; символические ссылки не разрешаются.
Пустой путь и аргументы неверного типа отклоняются.

Адресный запрос не приобретает, не продлевает и не удаляет блокировки, не
меняет fencing token или метрики. Истёкшая блокировка не возвращается, но
её очистка остаётся за существующими операциями. Вызов без аргументов или
с `{}` сохраняет общий список и прежнюю очистку истёкших блокировок.

`npm run test:mcp` использует отдельный временный socket, файл метрик и
синтетические идентификаторы; не обновляет статусы живых агентов. Старый
`tests/daemon-smoke.mjs` не изолирует метрики и статусы: не запускайте его
рядом с рабочим демоном.

### Доставка новой схемы

Сборка сама по себе не обновляет работающий демон. Он хранит блокировки
в памяти: перезапуск допускается только в согласованное окно, когда все
участники прекратили новые операции записи и активных блокировок нет.
После обновления демона клиентам требуется переподключение/перезагрузка
MCP-каталога. Проверяйте версию из `package.json` в `initialize.serverInfo`
и `gateway_status.gateway_version`, а в `tools/list` — необязательный
`gateway_status.inputSchema.properties.file`. Совпадение версии без новой
схемы не подтверждает доставку.

Общая приёмка выпуска:
[Twelve-Factor/MCP](https://github.com/aisystant/DS-ecosystem-development/blob/main/C.IT-Platform/C2.IT-Platform/C2.3.Operations/README.md).
Изолированные тесты не являются приёмкой текущего рабочего демона.

## Связанные документы

- [DP.SC.034](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.034-local-mcp-gateway.md) — обещание Local Gateway
- [DP.SC.035](../../PACK-digital-platform/pack/digital-platform/08-service-clauses/DP.SC.035-peer-agent-choreography.md) — peer-agent choreography поверх Gateway
- [DP.IWE.005](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.IWE.005-local-gateway.md) — Pack-сущность
- [DP.ROLE.039](../../PACK-digital-platform/pack/digital-platform/02-domain-entities/DP.ROLE.039-peer-agent.md) — Peer Agent роль
