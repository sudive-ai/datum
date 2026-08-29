# 2026-08-30 — 存储接缝（`@sudive-ai/datum-storage`）与会话重启恢复

## Problem

"日志是唯一事实源"之前只活在进程内存里——进程一退，事实全失。运行时需要一个
可插拔的持久化引擎：本地默认开箱即用，共享部署可选接入；且无论字节来自哪个
引擎，读取都必须走同一条 fail-closed 验证路径。

## Decision

- **三角色接缝**：`StorageAdapter`（Definition：`append` / `load` /
  `listSessions` / `close`），SQLite 与 PostgreSQL 两个 Provider，工作台是
  Consumer。`append` 按 (session, seq) 幂等（`INSERT OR IGNORE`），重放与
  崩溃重试不会写坏日志。
- **SQLite 为默认本地引擎**：Node 内置 `node:sqlite`（`DatabaseSync`），零
  原生编译；Node 22.x 需 `--experimental-sqlite` 旗标（23.4+ 无需）。fs 文件
  方案不再另做——SQLite 已覆盖本地场景且可查询。
- **PostgreSQL 为可选引擎**：postgres.js 驱动（ESM、无原生编译）；连接串从
  环境变量读取（`connectionStringEnv`，默认 `DATUM_PG_URL`），未设置则启动
  即失败——密码永不进配置文件、永不进日志。jsonb 存 envelope，读取经同一
  `validateSessionEnvelope` 验证。
- **挂载与恢复**：`mountSessionPersistence` 订阅 `session/event`（与 UI 投影
  同一条有序广播）写入引擎；失败**点名上抛**（logger 记录引擎+seq 后
  rethrow），其 disposer 会**排干**在途写——`close` 先排干再关库，日志尾部
  不丢。`openPersistentSessionLog` 恢复最近活跃会话（或指定会话）：
  引擎 fail-closed 读 → `SessionLog` 带 entries 重建（seq 无缝校验）→ 挂载
  持久化；工作台再把已恢复条目显式重放进 presenter（live = replay 从第一帧
  成立）。
- **工作台配置**：`storage.engine = 'sqlite' | 'postgres' | 'memory'`（默认
  sqlite，路径 `datum.db`；`memory` 保留旧的临时行为，供测试/一次性演示）。

## Consequences

- 重启恢复成为机制化验收门：工作台 e2e 先后两次启动（同库文件），历史与
  busy 状态完整回归；SQLite/Postgres 共享同一 conformance 测试（写入、
  fail-closed 读取、幂等重放、会话清单、未知会话空集）。
- 发现并修复了一个真实的丢尾问题：v1 的 fire-and-forget 写入在 close 时未
  排干，重启丢最后一两条事实——drain 语义进接缝契约，测试钉死。
- 长期记忆（"记忆"）暂不建表：它同样是有序事实，等需求到来时在同一接缝上
  加一类词表事件或一张事实表即可，不预造空闲机制。
- demo 的提示与 README 已更新：`pnpm demo` 默认落 `datum.db`，重启对话还在；
  `DATUM_STORAGE_ENGINE=postgres DATUM_PG_URL=…` 切换共享存储。
