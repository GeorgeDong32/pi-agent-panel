# pi-agent-panel 深度调研（Phase 1）

> 日期：2026-09-07。调研者：独立重做（上一 agent 的草稿仅作待验证参考，所有 file:line 均经本人复核或新发现）。
> 环境：pi CLI 0.85.1（`~/Library/pnpm/bin/pi`）。本地参考源码：`/Users/gd32/Coding/Pi-Extension/pi-subagents`（0.35.1，devDeps 钉 `@earendil-works/*` 0.81.0）。竞品：npm `@tintinweb/pi-subagents` 0.19.0、`pi-subagents-lite` 1.13.1（实包 tgz 拆解）。官方文档：pi.dev/docs/latest/extensions 与 /json（当日抓取全文）。
> 方法：源码逐文件阅读 → 竞品 tgz 拆解 → 官方文档对照 → 真实 `pi --mode json` 事件流实测（`/tmp/pi-json-sample.txt`，13 行完整捕获）。

## 1. pi-subagents 关键源码事实（本人逐行复核）

### 1.1 ExtensionAPI / 生命周期（`src/extension/index.ts`，598 行）

- 入口 `export default function (pi: ExtensionAPI): void`；child 进程早退：`process.env.PI_SUBAGENT_CHILD === "1"`（index.ts:191-193）。
- `pi.registerTool({name, label, description, parameters, prepareArguments, execute(id, params, signal, onUpdate, ctx), renderCall(args, theme), renderResult(result, options, theme, context)})`（index.ts:396-451）。
- `pi.registerMessageRenderer<T>(type, (message, options, theme) => Component | undefined)`（index.ts:303-361）。
- `pi.on("session_start" | "session_shutdown" | "agent_end" | "tool_result", (event, ctx) => ...)`（index.ts:455, 500, 552, 558）。
- `pi.events`：类型层只定义 `on(event, handler): (() => void) | void` 与 `emit(event, data)`（rpc.ts:60-63）；`off/once` 未在源码类型或官方文档中确认——v1 只用 on/emit。
- **stale ctx 三层防御**（模式照抄）：
  1. `state.lastUiContext = ctx` 仅在 `ctx.hasUI` 时更新（index.ts:500-508），事件处理经 `getContext()` 取最近 live ctx；
  2. `isStaleExtensionContextError()` 识别 `"Extension context no longer active"`（index.ts:127-129），session_shutdown 清 widget 时吞该错误（index.ts:590-596）；
  3. `/reload` 防陈旧：globalStore 存 runtime cleanup 函数 + 事件退订数组，重复加载先清理旧定时器/订阅（index.ts:195-204、462-474）。
- session_shutdown 全量清理模式：退订 events、清 poller/cleanupTimers、cancel bridges、setWidget(key, undefined)（index.ts:558-597）。

### 1.2 Fleet overlay（`src/tui/fleet.ts`，409 行）——只读骨架可照抄

- 打开：`ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new Component(...), { overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 } })`（fleet.ts:400-408）。
- Component 协议：`render(width): string[]`、`handleInput(data)`、`invalidate()`、`dispose()`；`tui.requestRender()` 手动重绘；`tui.terminal?.rows` 取行高（fleet.ts:243-398, 359）。
- 键盘：`matchesKey(data, "escape"|"ctrl+c"|"q"|"up"|"down"|"k"|"j"|"home"|"end"|"pageUp"|"pageDown")`（@earendil-works/pi-tui，fleet.ts:296-322）。
- 刷新：`setInterval(refresh, 750)` + `.unref()`；快照整体重建 + 按 `selectedKey` 保持选中项跨刷新稳定（fleet.ts:272-286）。
- 渲染素材：`theme.fg("accent"|"muted"|"success"|"warning"|"error"|"dim"|"border", s)`、`theme.bold(s)`、`truncateToWidth`、`visibleWidth`、`wrapTextWithAnsi`（fleet.ts:232-241, 329-353）。
- 双栏布局：roster 38% 宽（clamp 22-46）/ detail 余量；窄于 36 列降级单行提示（fleet.ts:356-361）。
- **"inspection only" 的根因**：数据源是磁盘 status 文件 + 内存 foregroundControls，无输入通道回写 child（fleet.ts:371 标题行自认）。

### 1.3 spawn 管线（`src/runs/shared/pi-args.ts` + `pi-spawn.ts` + `foreground/execution.ts`）

- 完整命令：`pi --mode json -p [--session <file>|--no-session|--session-dir <dir>] [--model m[:thinking]] [--permission-mode x] [--tools t1,t2] [--no-extensions --extension <path>...] [--no-skills] [--system-prompt|--append-system-prompt <file>] [Task: ... | @<file>]`（pi-args.ts:111-304；`baseArgs = ["--mode","json","-p"]`，execution.ts:217）。
- 大 prompt 通道：task > 8000 字符写临时 md、以 `@<path>` 传入（pi-args.ts:17, 196-205）。
- pi 可执行文件定位：`PI_SUBAGENT_PI_BINARY` env 覆盖 → `resolvePiPackageRoot()`（`process.execPath` + 从 `process.argv[1]`/`import.meta.resolve("@earendil-works/pi-coding-agent")` 找 bin）→ 兜底 `"pi"` 走 PATH（pi-spawn.ts）。在 pi 扩展进程内 `process.argv[1]` 即 pi CLI，第一条链路天然可用。
- spawn 参数：`stdio: ["ignore","pipe","pipe"]`、`windowsHide: true`（execution.ts:320-327）；env = `{...process.env, ...sharedEnv}`（execution.ts:317）。
- ~20 个 `PI_SUBAGENT_*` 环境变量协议（pi-args.ts:20-39 定义、:207-301 装配），child 侧经 `--extension subagent-prompt-runtime.ts` 注入消费（pi-args.ts:18, 169-181——runtime extension 无条件注入）。
- stdout 逐行处理（execution.ts:662-772）：全行镜像 `jsonlPath`；`JSON.parse` 容错非 JSON 行（原样落 transcript）；消费 `tool_execution_start/end`（toolName/args、toolCount、当前工具/路径）、`message_end`（messages.push、usage 聚合 input+output+cacheRead+cacheWrite+cost.total、`progress.tokens = input+output`）、`agent_settled`（execution.ts:674）。
- **终态判定信号**（NotificationBridge 依据）：`message_end` 且 `role==="assistant"` 且 `stopReason==="stop"` 且 content 无 toolCall = terminalAssistantStop（execution.ts:745-748）；终态消息后开 exit drain 窗口再等进程退出（execution.ts:763-768）——exit 与终态消息可能乱序，drain 窗口兜底。

### 1.4 控制通道（`src/runs/background/control-channel.ts`，579 行）与 steering

- 文件型控制 inbox（跨 OS，信号只是 fast-path）：run 目录下 `control/interrupt.json`、`control/stop.json`、`control/steer-requests/*.json`（control-channel.ts:85, 100, 110）；`writeAtomicJson`（temp+rename）落盘；runner 侧 `fs.watch` + `setInterval` 兜底轮询（control-channel.ts:511-566）。
- child 侧消费在 `subagent-prompt-runtime.ts`：steer inbox 轮询（fs.watch + 250ms interval，:298-315）→ `(pi as {sendUserMessage?...}).sendUserMessage(formatted, {deliverAs:"steer"})`（鸭子类型，:207/233/272）→ ack 文件（:242-251）；**delivered ack 的判定依赖 `pi.on("input")` 事件回调**（input.source==="extension" && streamingBehavior==="steer" 匹配 pending，:285-297）；capability 文件声明 child 是否支持 steer（:252-255，运行时探测 `typeof sendUserMessage === "function"`）。
- `steering.ts`（237 行）只是状态记账（请求记录/计数/recovery claim/等待循环），实际投递走上述 inbox。
- **对 v1 的含义**：我们直接持有 child 进程句柄（非 detached），interrupt/stop 直接信号即可，不需要文件 inbox；文件协议是 detached 场景的产物。steer 二期做时沿用「inbox + child 侧 runtime extension + ack」模式。

### 1.5 session 租约（`src/runs/shared/session-lease.ts`，280 行）

- 防两写者打开同一 session 文件：sha256(canonical path) 定目录，`mkdir(temp) → 写 owner.json → rename` 原子创建（:101-106, 170-187）；stale 判定 = hostname 相同 + pid 死亡（`kill(pid,0)` ESRCH）+ 进程启动身份交叉验证（linux /proc stat startTicks、darwin `ps -o lstart=`，:64-95, 149-168）；4 次重试 + tombstone 防竞态（:222-275）。
- **对 v1 的含义**：每 child 用全新唯一 session 文件，自始至终单写者，**首版不需要租约**；二期做 resume/revive 再引（决策 D6）。

### 1.6 RPC 桥（`src/extension/rpc.ts`，378 行）——确认不复用

- 五方法 `ping/status/spawn/interrupt/stop` 跑 `pi.events` 总线，事件名 `subagents:rpc:v1:*`（rpc.ts:14-19, 347-377）。
- 限制确认：`spawn` 强制 `async: true` + 禁 `clarify`（rpc.ts:206-213）；`stop` 仅支持 active session 的 running async run（sessionId 归属校验，rpc.ts:238-255）；全部方法经 pi-subagents 自己的 executor 执行。
- 跨包复用 = 绑定其 TypeBox params schema、async run 目录布局、executor 接口与版本节奏。维持 handoff 结论：**不复用**。

## 2. 竞品 fleet view 对比（npm 实包 tgz 拆解，2026-09-07）

### 2.1 @tintinweb/pi-subagents 0.19.0（peerDeps `@earendil-works/* >=0.84.0`）

- **架构：in-process AgentSession**。`createAgentSession` + `runInChildSessionContext(() => createAgentSession(sessionOpts))`（dist/agent-runner.js:7, 784）；无子进程 spawn。
- fleet 列表（dist/ui/fleet-list.js）：`ui.custom` overlay + setInterval 刷新 + j/k 选择；**Enter 打开该 agent 的 live conversation overlay，提交调用 `this.manager.steer(record.id, message)`**（fleet-list.js:374）。
- steer 链路：`record.session.steer(message)`（agent-manager.js:1079）；spawn 前到达的 steer 先 flush（agent-manager.js:601-604）；turn 限额用 `session.steer("wrap up")` 软收尾。
- **版本漂移实锤**：源码注释 `// Pi 0.80.8 replaced createAgentSession's modelRegistry option with ...`（agent-runner.js:758-769，带 pre-0.80.8 shim）——SDK session API 面在版本间真实漂移。
- 通知回注：`pi.sendMessage({...}, { deliverAs: "followUp", triggerTurn: true })`（dist/index.js:423-428, 461-466, 2194-2210）。

### 2.2 pi-subagents-lite 1.13.1（AlexParamonov，零 deps，peerDeps `>=0.82.0`）

- **架构同样是 in-process**：`createAgentSession(sessionOpts)` + `SessionManager.inMemory(cwd)` + `session.subscribe(handler)` + `session.prompt(prompt)` + `session.abort()`（src/agents/agent-runner.ts:13, 146-228, 518-532, 616-654）。`src/spawn/` 目录是 worktree/trust 协调（project-trust.ts / spawn-coordinator.ts / worktree-validator.ts），不是子进程管理。
- conversation-viewer：live overlay + steer composer——Enter 唤起（仅 `canSteer()` 时，conversation-viewer.ts:177-180）、Enter 发送/Esc 退出（:163）；**running→"steer"、settled→"continue" 动词区分**（:313-315）。
- 通知回注：`pi.sendMessage(..., { deliverAs: parentIdle ? "followUp" : "steer" })`（src/spawn/spawn-coordinator.ts:208-218）——按主会话 idle 态动态选 deliverAs，是值得借鉴的细节。
- **in-process 自伤实证**：注释记录 `sendMessage failed (shared runtime overwritten by subagent bindCore)`（spawn-coordinator.ts:223）——in-process subagent 会污染宿主 runtime，连通知回注都会被打断。

### 2.3 对比结论

| 维度 | nicobailon pi-subagents（本地 0.35.1） | tintinweb 0.19.0 | lite 1.13.1 | pi-agent-panel（本包） |
|---|---|---|---|---|
| child 形态 | subprocess `pi --mode json -p` | in-process session | in-process session | **subprocess** |
| fleet/viewer 可交互 | 否（inspection only） | **steer + 查看** | **steer + 查看** | v1: 查看 + stop/interrupt；二期 steer |
| 通知回注主会话 | 有 | 有（followUp+triggerTurn） | 有（按 idle 态选 followUp/steer） | v1 必做 |
| 进程/内存隔离 | 强 | 弱（共享进程，bindCore 污染实证） | 弱（同左） | 强 |
| 面板视角 | 只列自己的 run | 只列自己 spawn 的 agent | 只列自己 spawn 的 agent | panel 作为一等调度入口 |

- **勘误 A 验证成立**（详见 §5）：tintinweb 与 lite 均已支持 viewer 内 steer，handoff「都是只读观察」不成立。真正的空白收窄为：(a) **subprocess 隔离**的可操作 fleet（二者均绑死 in-process）；(b) 面板作为一等调度入口（spawn 也可从面板发起，而非只能观察既有 run）；(c) CC 式「终态结构化通知回注 + 内存安全不变量」完整闭环。
- in-process 路线的三重代价有实证：SDK API 面漂移（tintinweb 0.80.8 注释）、宿主 runtime 污染（lite bindCore 注释）、爆炸半径与主 TUI 共享（CC 36.8GB 事故的结构性放大器）。CLI 面（`--mode json` 事件流 + flag 集）比 SDK 面稳定得多（本地 0.81.0 类型钉版仍能驱动 0.85.1 CLI）。

## 3. 官方文档校正（pi.dev/docs/latest/extensions + /json，2026-09-07 抓取全文）

以下签名以官方文档为准；✅ = 官方文档与本地实证一致，⚠ = 差异/新信息：

- ✅ `pi.registerCommand(name, {description, handler: async (args, ctx) => {}})`（含 getArgumentCompletions 可选）。
- ✅ `pi.registerShortcut(shortcut, {description, handler: async (ctx) => {}})`；pi-effort 实例：`pi.registerShortcut("ctrl+shift+e", {...})`（pi-effort/index.ts:125-139）——**ctrl+shift+e 已被占用**，本包选 alt+p。
- ✅ `ctx.ui.custom<T>(factory, options?): Promise<T | undefined>`；factory = `(tui, theme, keybindings, done) => Component`；options = `{overlay?: true, overlayOptions?: {anchor, width, minWidth, maxWidth, maxHeight, margin}, onHandle?}`；OverlayHandle = `focus()/unfocus({target})/setHidden(bool)/hide()`；`done(result)` 关闭并 resolve。⚠ **overlay 模式官方标注 Experimental**。
- ✅ `ctx.ui.setWidget(key, lines | factory(tui, theme), {placement: "aboveEditor"(默认)|"belowEditor"})`；`ctx.ui.setStatus(key, text)`、`setHeader/setFooter/setTitle/notify(text, level)`、`setEditorComponent`。
- ⚠ **`ctx.ui.onTerminalInput`：官方 extensions 文档未收录该名字，但运行时真实存在**——本地 pi-goal/extensions/goal.ts:886 与 pi-subagents/src/slash/slash-commands.ts:600-601 均在 0.85.1 下实际调用。定性：未文档化 API，无兼容承诺。v1 不依赖（ui.custom 的 handleInput 已覆盖面板键盘需求），标记未验证、不用。
- ✅ `pi.sendMessage(message, {triggerTurn?: boolean, deliverAs?: "steer"(默认) | "followUp" | "nextTurn"})`——注意有**三个** deliverAs 值（handoff 只列两个）。
- ✅ **`pi.sendUserMessage(content, options?)` 已被官方文档正式收录**（options 含 `deliverAs: "steer"|"followUp"`、`expandPromptTemplates`）——勘误 B 成立，二期 steer 的 child 侧通道有官方背书。
- ✅ `ctx.isIdle()` / `ctx.hasPendingMessages()` / `ctx.hasUI` / `ctx.mode`（"tui"|"rpc"|"json"|"print"）；JSON/print 模式下 `ctx.hasUI === false`、UI 方法为 no-op——child 里加载本扩展必须早退（双保险：env 标记 + hasUI 判断）。
- ✅ `pi.events`：文档展示 `on/emit`；自定义事件名建议 `agent-panel:<scope>:<event>`。
- ⚠ 会话生命周期（修正草稿错误）：官方事件为 `session_start`（`event.reason: "startup"|"reload"|"new"|"resume"|"fork"`）与 `session_shutdown`（同族 reason）；**不存在** `session_start:init` / `session_switch` 这类事件名（草稿 §3 原文有误）。另有 `session_before_switch/session_before_fork` 等钩子。
- ✅ 官方明确要求：**长生命周期资源（进程/socket/watcher/timer）不得在 factory 里启动，推迟到 `session_start` 或首个需要它的 command/tool/event；`session_shutdown` handler 必须幂等**。Supervisor 生命周期照此办理。
- ✅ stale ctx 官方 footgun 正式确认："Captured old `pi` / old command-ctx session-bound objects are stale after replacement and will throw if used"；命令/快捷键 handler 每次收到 fresh ctx。render 闭包禁碰 ctx 的硬约束与官方语义一致。
- ✅ `pi.getAllTools()` 官方定义；`tool.sourceInfo.source`（builtin/sdk/extension）可判工具归属（auto-yield 检测预留）。

### 3.1 JSON Event Stream 契约（官方文档 + 实测双重确认）

实测命令：`pi --mode json -p --no-session "Reply with exactly the word: pong"`（完整 13 行已存 `/tmp/pi-json-sample.txt`）：

- 首行 `{"type":"session","version":3,"id","timestamp","cwd"}` ✅ 实测一致。
- 事件序（实测）：`agent_start → turn_start → message_start(user) → message_end(user) → message_start(assistant) → message_update×N（delta-only：text_start/text_delta/text_end）→ message_end(assistant，权威完整 message+usage+stopReason) → turn_end → agent_end（携带全量 messages）`。
- usage 结构（实测）：`{input, output, cacheRead, cacheWrite, totalTokens, cost: {input, output, cacheRead, cacheWrite, total}, cacheWrite1h}`，挂在 message_end 的 message 上；assistant message 含 `api/provider/model/stopReason/errorMessage`。
- ⚠ **`agent_settled`：实测存在（实测流最后一行 `{"type":"agent_settled"}`）且 pi-subagents 消费它（execution.ts:674），但官方 json 文档事件列表未收录**。定性：真实契约的一部分、文档缺口。contract test 必须钉住它，但 v1 逻辑不单独依赖（终态以 message_end + 进程 exit 双信号判定）。
- 非 JSON 行容错：官方文档要求「转义不可解析行要容错」；pi-subagents 同款处理（execution.ts:668-671）。
- 运行模式语义：`-p` = print 模式（扩展照常加载）；`--mode json` = print + 事件流；完整 UI 仅 interactive tui 模式。

## 4. 可搬模式清单（CC 拆解 × 本包取材）

1. CC「渲染即换消息源」（REPL.tsx:4494-4510）→ FleetPanel transcript 列 = Supervisor 的磁盘 transcript 尾部读取 + 聚合预览；无多终端仿真。
2. CC「UI mirror 上限 50 条 + disk 全集」→ 本包更紧：**Supervisor 每 child 常驻内存只有标量聚合（tokens/toolCount/lastLine），零行级内存镜像**；全量事件流双落盘（child 自己写的 `--session` JSONL + 面板自己的 events.jsonl 镜像）；面板 transcript 一律按需读磁盘尾。不变量："disk 是全集，live 是后缀"。
3. CC「`<task-notification>` 回注 + notified 防重」→ NotificationBridge：child 终态 → `pi.sendMessage({customType, content, display, details}, {triggerTurn: true, deliverAs: "followUp"})`，childId 记 notified 标志防重。
4. lite 的 idle 感知 deliverAs（spawn-coordinator.ts:208）→ 本包 v1 固定 followUp（主会话忙时 followUp 自动排队，官方语义），二期再评估 idle 动态切换。
5. pi-subagents 的 fleet.ts 骨架（overlay 参数/键位/刷新/选中保持）→ FleetPanel 直接沿用，增加操作键。

## 5. 对 handoff 的勘误验证（上一草稿 §5 三处勘误，本人逐条复核）

| # | handoff 原结论 | 勘误验证结果 | 本人新增证据 | 影响 |
|---|---|---|---|---|
| A | 「现成方案共性：都是只读观察」 | **成立** | tintinweb fleet-list.js:374 steer 调用、agent-manager.js:1079 `session.steer`；lite conversation-viewer.ts:177-180, 313-315 steer composer + 动词区分 | 机会点收窄为「subprocess 隔离的可操作 fleet + 面板作为调度入口 + 通知闭环」；design.md 差异化定位据此措辞 |
| B | 「`pi.sendUserMessage` 仅鸭子类型可用」 | **成立** | 官方 extensions 文档 ExtensionAPI Methods 节正式收录 `pi.sendUserMessage(content, {deliverAs, expandPromptTemplates})` | 二期 steer 的 child 侧通道有官方背书，风险降级 |
| C | 「`ctx.ui.onTerminalInput` 可用」 | **成立（需精确化）** | 官方 extensions 文档确实未收录；但 pi-goal/goal.ts:886 与 pi-subagents/slash-commands.ts:600-601 在 pi 0.85.1 实际调用 | 定性为「运行时存在、文档未收录」；v1 不依赖（handleInput 足够），不承担未文档化 API 风险 |

### 5.1 对上一草稿本身的修正（本人在复核中发现）

1. 草稿 §3 写 `session_start:init / session_start:resume / session_start:fork / session_switch` 事件名——**错误**。官方是 `session_start` + `event.reason` 字段；`session_switch` 不存在（是 `session_before_switch`）。
2. 草稿 §1.3 把 `agent_settled` 与官方事件并列陈述——应标注：实测存在、官方 json 文档未收录（文档缺口，非官方契约面）。
3. 草稿开头说「2 处勘误」而 §5 列 3 处——笔误，实为 3 处且全部验证成立。
4. 草稿 §3 称 `pi.events` 有 `off/once`——两个来源（源码类型 + 官方文档）都只确认 on/emit，v1 只用已确认面。

### 5.2 实现期新发现（Phase 3，本人实证）

5. **`--permission-mode` 不是 pi 内建 flag**——`pi --help` 明示「Extensions can register additional flags」，该 flag 由 permission 扩展（如用户的 pi-permission-modes）注册。pi-args.ts:133-143 的转发因此混入了生态自定义 flag：child 以 `--no-extensions` 启动时该 flag 直接 `Unknown option` 退出（实测复现）。**教训：pi-args 的 flag 清单 ≠ 内建 CLI 面**；本包 buildChildArgs 仅在显式请求时转发它，默认不带。headless child 的默认工具权限行为（不带该 flag 时 pi -p 如何裁决工具调用）未验证，列入 README 已知限制。

## 6. CC agent panel v2.1.261 拆解（用户实测截图，2026-09-07）

> 本地 CC 源码快照（/Users/gd32/Coding/claude-code/src）落后于 v2.1.261，无对应组件；以下以用户提供的运行截图为规格，结合旧版拆解（handoff：渲染即换消息源、viewSelectionMode 状态机）交叉印证。

- **全屏接管**：列表占满整个终端视口（非浮窗 dialog）；底部保留输入框（placeholder "Describe a task for a new session"）与 footer 键位行——即「主内容区整体切换 + editor/footer 常驻」。pi 对应物：pi-tui overlay 渲染在整个终端上（tui.js resolveOverlayLayout 以 termWidth/termHeight 为基准，margin 才会收缩可用区），`width:"100%" + maxHeight:"100%" + margin:0` 即真全屏（类型 OverlayOptions 实证，tui.d.ts:134-156）。
- **分组列表**：`Pinned / Working / Completed` 三组；行结构 = 状态点 + 会话名 + 最新活动摘要（一句话）+ 会话 id + 相对时间。
- **头部计数**：`0 awaiting input · 1 working · 5 completed`——CC 语义中 awaiting input = 等用户输入的 agent。
- **随时跳转**：选中 + enter 进入该会话视图（旧版实现 = REPL 切换 displayedMessages 消息源），会话视图里 enter 返回列表（"enter to return"）。列表/会话两级视图 + enter 往返是核心动线。
- **space to reply**：列表上直接对选中 agent 输入回复（steer）；对已结束会话则是 continue 语义（对应 lite 的 running→steer / ended→continue 动词区分，research.md §2.2）。
- **ctrl+x to delete**、**? for shortcuts**、**bypass permissions 徽标**（权限模式回显，二期 permission 桥接范畴）。
- **从列表直接 spawn**：底部输入框输入任务描述即创建新会话——panel 是一等调度入口（不是只读检查器）。

## 7. 版本漂移风险台账（与 D1 联动）

- 证据链：tintinweb 源码注释记录 0.80.8 更换 `createAgentSession` 选项（agent-runner.js:758）；本地 pi-subagents devDeps 钉 0.81.0 vs 当前 CLI 0.85.1；tintinweb peerDeps >=0.84.0——**SDK 类型面约每 1-2 个 minor 漂移一次**，而 CLI 面（flag 集 + `--mode json` 事件流）自 0.81→0.85 稳定（本地包实证）。
- 依赖策略：运行期零 `@earendil-works/*` 硬依赖（扩展宿主自带）；类型仅 devDependency + `import type`（构建期擦除）；组件协议类型（Component/TUI）鸭子类型降级或最小本地声明。对外契约只钉 CLI 面，用 contract tests 固化（§3.1）。
