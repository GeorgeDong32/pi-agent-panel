# Handoff: pi-agent-panel v2（rpc 长驻架构）实施

> 交接时间：2026-09-08。前一阶段（本会话）完成了 v0.1.0 实现（已提交）与 v2 设计定稿（用户已评审+修订+审查通过）。你的任务：**按已定稿规格实施 v2**。这是实施型 handoff——架构与交互已拍板，不需要重新调研或重新设计；实现中发现规格矛盾或新风险，记录并上报，不要静默改决策。

## 1. 背景（30 秒版）

- 包：`pi-agent-panel`（`/Users/gd32/Coding/Pi-Extension/pi-agent-panel`），对标 Claude Code 的 agent panel。
- v0.1.0（提交 d16d2f2）：「95%×85% 浮窗检查器」形态，spawn/list/stop + transcript + 通知回注 + pill，测试 26 绿。**功能正确但形态被否**。
- 用户用 CC v2.1.261 实拍反馈：人家是**全屏 + 随时跳转**，且核心诉求「enter 跳进去要像正常对话一样聊」。
- 关键发现：pi 官方 `--mode rpc` 长驻模式 + SDK `RpcClient` → 跳转=真对话。v2 方案据此定稿（proposal-v2.md r3）。

## 2. 必读文件（按序，读完再动手）

1. **`docs/proposal-v2.md`（r3）——唯一权威规格**：§0 架构对比、§2 布局与键位总表、§3 的 11 条关键设计点、§4 诚实差距边界、§5 交付清单、§8 审查记录（8 处已修缺口，理解为什么这么设计）。
2. 本文（handoff-v2.md）。
3. `docs/research.md` §6/§7 —— CC v2 面板拆解、版本漂移台账（背景知识）。
4. 现有代码：`extensions/index.ts` + `extensions/lib/{types,pi-spawn,runner,supervisor,panel,bridge,pill}.ts` + `test/`（v0.1.0 基线，Supervisor/Panel 将重写，pi-spawn 的 binary 解析、bridge 防重骨架、pill 可复用）。

## 3. 已定决策（用户拍板，不可推翻；重新讨论 = 打回）

| # | 决策 | 出处 |
|---|---|---|
| 1 | child 形态 = **长驻 `pi --mode rpc`**（经宿主包 RpcClient）；一次性任务用 spawn+首条 prompt 覆盖，turn 结束不退出 agent | proposal §0/§3，用户 2026-09-08 OK |
| 2 | `x` = 打断当前轮（rpc abort，agent 存活）；`X`/ctrl+x = **归档**（kill + 列表隐藏，JSONL 保留，归档集持久化 state.json） | 用户修订 + r3 审查 #2 |
| 3 | `←` 返回列表（Esc 同效） | 用户修订 |
| 4 | 通知抑制：面板内发起的 turn、正被查看的 agent → 不回注；仅后台 turn 结束回注（事件带 origin） | r3 审查 #1 |
| 5 | composer 基于 pi-tui `Editor` 组件内嵌（CJK/粘贴可用），不用裸 char-append | r3 审查 #4 |
| 6 | child 隔离：`options.args` 带 `--no-extensions --no-skills`，`options.env` 注入 `PI_AGENT_PANEL_CHILD=1`；`extension_ui_request` **主动 deny** | r3 审查 #5 |
| 7 | limit 默认从 8 收紧到 **4**；模型默认跟全局配置，主会话临时切换经 spawn 转发一次 | r3 审查 #7 |
| 8 | 状态推导：`agent_start`/`agent_end` 事件推 isStreaming；仅 spawn 后一次 `getState()` 对齐初态；750ms 定时器只刷新 UI | r3 审查 #6 |
| 9 | 分组 = Working / Awaiting input / Archived | 用户确认 |
| 10 | 二期不做：permission 桥接（extension_ui_request 转发）、跨 pi 重启 revive（`R` 键预留）、setEditorComponent 全编辑器 | proposal §4 |

## 4. 已实证结论（可直接采信，勿重复验证；pi 0.85.1 安装包源码）

| 事实 | 证据 |
|---|---|
| overlay 支持全屏：`width:"100%" + maxHeight:"100%" + margin:0` 渲染整个终端（盖住 pi dock） | pi-tui `dist/tui.d.ts:134-156`（OverlayOptions）；`tui.js:780-812` resolveOverlayLayout 以 termWidth/termHeight 为基准，仅 margin 收缩可用区 |
| `RpcClient` 官方导出：`start/stop/prompt/steer/followUp/abort/clearQueue/newSession/getState/setModel/setThinkingLevel/onEvent/getStderr`；`RpcClientOptions: {cliPath, cwd, env, provider, model, args}` | pi-coding-agent `dist/index.d.ts:27`、`dist/modes/rpc/rpc-client.d.ts` |
| rpc 命令面：`prompt`（含 `streamingBehavior:"steer"|"followUp"`）/`steer`/`follow_up`/`abort`/`clear_queue`/`new_session`/`get_state`/`set_model`/`compact`… | `dist/modes/rpc/rpc-types.d.ts`（RpcCommand） |
| `RpcSessionState`: `isStreaming/isCompacting/sessionFile/sessionId/messageCount/pendingMessageCount/model/thinkingLevel` | rpc-types.d.ts:148-160 |
| `extension_ui_request`：select/confirm/edit 三类，等 `extension_ui_response` | rpc-types.d.ts:397-412 |
| **孤儿自愈**：rpc child 监听 `process.stdin.on("end")` → shutdown → `process.exit`；父进程怎么死管道都关，child 全部自杀，无需启动清扫器 | `dist/modes/rpc/rpc-mode.js:644`（监听）、`:581-597`（shutdown/exit） |
| RpcClient 起进程面：`spawn("node", [cliPath, ...args])`，env = `{...process.env, ...options.env}`，stop() = SIGTERM→宽限→SIGKILL | `dist/modes/rpc/rpc-client.js:32-44, 89-98` |
| 事件流 = `JsonAgentSessionEvent`，与 `--mode json` 同族（message_*/tool_execution_*/agent_start/agent_end）→ transcript 渲染与既有 contract test 复用 | rpc-mode.d.ts / json-event.d.ts |
| 扩展运行时可以按包名导入宿主包的**值**（非仅类型） | pi-claude-code-tui `extensions/claude-code-tui.ts:28`（生产实证） |
| `matchesKey` 键名含 `backspace/pageUp/pageDown/escape/enter` 等 | pi-tui `dist/keys.d.ts:32` |
| pi 内建 flag 清单与「扩展可注册 flag」；`--mode rpc` 官方三模式之一 | `pi --help` |

## 5. 磁盘现状与第一步（重要，先做这个）

**已提交**：v0.1.0（`d16d2f2`），测试基线 unit 22 + contract 1 + integration 3 全绿。

**未提交改动 = r1（一次性 child + 文件 inbox steer）路线遗留，在 rpc 路线下全部作废。第一步回滚**：

```bash
cd /Users/gd32/Coding/Pi-Extension/pi-agent-panel
git checkout -- extensions/lib/supervisor.ts extensions/lib/types.ts extensions/lib/pi-spawn.ts
rm extensions/lib/child-steer-runtime.ts
pnpm test && pnpm test:contract   # 应回到 22+1 全绿再开工
```

**保留不回滚**：
- `docs/proposal-v2.md`（r3 规格）与 `docs/proposal-v2_副本.md`（用户手改的历史快照，不维护、不删除）
- `docs/research.md` / `docs/design.md` 的未提交增补（D8-D10 是 r1 时代预写；实施收尾时按 proposal §5.9 同步定稿：D1 修订为 RpcClient 依赖、D5/D10 作废记录、新增 D11 rpc 会话池架构）

## 6. 实施清单（proposal §5）与风险闸门

**先写 4 个探针验证未验证项（半天内出结论，任一失败→停下上报，不要硬绕）**：
1. 扩展进程内值导入 `RpcClient` 并 start/stop 一个真 child（`pi -e ./extensions --no-session -p` 里或独立 node 脚本均可，重点验证 cliPath 用现有 `getPiSpawnCommand` 解析结果喂入）。
2. `options.args: ["--no-extensions","--no-skills","--session",<tmp>]` 能正常起 rpc child 且 `getState()` 返回 sessionFile。
3. `onEvent` 流里确认 `agent_start`/`agent_end`/`message_end`（状态推导依据）。
4. 全屏 overlay + pi-tui `Editor` 内嵌最小探针（`ui.custom` + overlayOptions 100%/margin 0 + 一个含 Editor 的组件，确认渲染与输入焦点）。

**然后按 proposal §5 的 9 项清单实施**（supervisor 重写为 rpc 会话池、rpc-session.ts 包装、panel 重写、bridge 触发点改 turn-end + 抑制规则、index.ts 适配、测试三件套、文档同步）。实施顺序建议：rpc-session 包装 + fake factory → supervisor → bridge/pill 适配 → panel → 探针补真 → 全量测试。

## 7. 硬约束（违反出事故）

1. **stale ctx**：render 闭包内禁碰 `ctx.*`；Panel 只用工厂传入的 live tui/theme + Supervisor 快照；render 零 IO 零异常路径（IO 只在 refresh/键处理上下文）。
2. **内存不变量**「disk 是全集，live 是后缀」：每 child 常驻内存只有标量聚合 + 事件镜像落盘（rpc 下镜像 = onEvent 对象再序列化）；transcript 一律按需读盘尾。
3. Supervisor 生命周期：`session_start` 建 / `session_shutdown` dispose（幂等）/ globalStore 防 `/reload` 重复加载（沿用 v0.1.0 模式）。
4. 测试面：单测一律走 `RpcSessionFactory` fake（脚本化事件回放），不碰真进程；真进程只出现在 integration/contract。
5. 工作约定：回复中文；代码注释英文且只写代码表达不了的约束；pnpm；最小改动；不输出/记录密钥令牌。

## 8. 验收标准（全部可执行/可复现）

1. `pnpm test` 全绿——新增/改写：rpc 会话池状态机（working⇄awaiting/crashed/archived）、abort 语义、归档（kill+state.json 持久化+列表隐藏）、通知抑制（origin=面板内→不发；focus=查看中→不发；后台→发+防重+配额）、limit 4、dispose 幂等。
2. `pnpm test:contract` 不变全绿（json 事件流契约钉子保留）。
3. `pnpm test:integration` 全绿（真 rpc child）：spawn→prompt→`agent_end`→**再 prompt（同 child 第二轮，真对话）**→运行中 abort→归档后进程树干净→孤儿自愈（手动起 rpc child 后关 stdin，断言限时退出）。
4. `pnpm typecheck` 零错误。
5. 冒烟：`pi -e ./extensions --no-session -p "say ok"` 退出码 0、stderr 干净。
6. 手动（人工，README 记录序列）：`/agent-panel` 全屏 → `n` 输中文任务 → enter 跳入 → 流式输出 → composer 追问（第二轮真对话）→ `←` 返回 → `x` 打断一个长任务 → `X` 归档 → 关 pi 后无残留进程。

## 9. 交付物

1. 可运行 v0.2.0 + 上述测试全绿，git 提交（含变更说明）。
2. 文档同步：design.md（D1 修订/D5、D10 作废记录/D11 新增/验收标准更新）、README（v2 键位与用法、人工验收序列）、CHANGELOG。
3. **「已验证项与未验证项」清单** + 人工复现路径（明确哪些探针结论、哪些仍是人工项）。
4. 实现中发现的规格矛盾/新风险 → 在 design.md 记一条决策修订并在交付说明列出（不要静默改）。
