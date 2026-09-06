# pi-agent-panel 设计（Phase 2）

> 依据：docs/research.md（2026-09-07，本人独立验证版）。目标：在 pi 的单终端 TUI 内调度多个 headless pi 子会话的可操作面板，对标 Claude Code agent panel 体验。
>
> 架构（codebase-design 词汇）：
>
> ```
> FleetSupervisor    ← deep module，seam 之所在：spawn/interrupt/stop/list/tail/onEvent/dispose
>                      零 TUI 代码、零 pi 运行时依赖（进程创建经 ProcessRunner seam 注入）
> FleetPanel         ← 薄 adapter #1：ctx.ui.custom overlay；render 纯函数，只读缓存快照
> NotificationBridge ← 薄 adapter #2：child 终态 → pi.sendMessage 回注主会话（防重 + 配额）
> StatusPill         ← 薄 adapter #3：ctx.ui.setWidget 常驻状态行 + auto-yield
> extensions/index.ts← 组装：命令 / 快捷键 / 生命周期 / globalStore 防 /reload
> ```
>
> 两个以上 adapter 跨同一 Supervisor seam → seam 真实。Supervisor 用 fake ProcessRunner 独立测试；Panel 的 render 不碰 ctx / 不做 IO → 天然绕开 stale ctx 陷阱。

## Decision Register

> 格式：候选方案（含未选者）→ 放弃了什么 → 风险由谁承担。D1-D4 来自 handoff；D5-D7 为调研中新增的必须决策项。每条决策的证据见 research.md 对应节。

### D1 child 形态与依赖策略 — 选：自研 subprocess spawn 管线

**候选方案：**

1. 复用 pi-subagents RPC 桥（`subagents:rpc:v1:*` 事件）。
2. in-process AgentSession（tintinweb / lite 路线：`createAgentSession` + `session.steer/abort/subscribe`）。
3. **自研轻量 spawn 管线**（`pi --mode json -p --session <fresh>`，抄 pi-args 模式但只保留 v1 需要的 flag）✅

**取舍：**
- 选 3 放弃了：方案 2 的零成本 steer（session 对象直调）与零成本 live 事件（subscribe 推流）——v1 因此没有 steer（由 D5 占位），事件要自己解析 JSONL。
- 放弃 1 的理由：spawn 强制 detached async + 绑定其 TypeBox schema / async run 目录布局 / executor 接口（research.md §1.6），且用户已被其 0.42→0.55 版本漂移打穿过一次（pi-review CHANGELOG）；跨包事件协议不在本包控制内。
- 放弃 2 的理由（research.md §2.3/§6 实证）：(a) SDK session 面逐版本漂移有实锤（tintinweb 记录 0.80.8 更换 createAgentSession 选项）；(b) in-process child 污染宿主 runtime 有实锤（lite 记录 subagent bindCore 覆盖共享 runtime 致 sendMessage 失败）；(c) 与主 TUI 共享进程内存，直接放大 CC 36.8GB 事故的爆炸半径；(d) subprocess 路线下 transcript-on-disk 从诞生即成立（child 自己写 `--session` JSONL），契合「disk 全集、live 后缀」不变量。

**风险承担者：** 本包承担 `--mode json` 事件格式漂移风险 → contract tests 钉住（research.md §3.1 已实测基线）；用户承担 v1 无 steer 的功能缺口（D4/D5 已明示，二期补）。

### D2 包形态 — 选：独立包 `pi-agent-panel`

**候选方案：**
1. **独立包** ✅
2. 并入 pi-claude-code-tui

**取舍：** 选 1 放弃了：与 TUI 包共享 theme/util 的便利、少装一个包。理由：单一职责（多会话调度 vs 视觉皮肤）；发布/回滚/启停互不牵连；TUI 包 1.2.1 的 stale-ctx 事故史说明两包失效模式不同，独立才好隔离。槽位共存用 auto-yield（D7）。

**风险承担者：** 用户多维护一个包目录；本包保证不占 TUI 包的既有槽位（D7 的 yield 义务）。

### D3 交互形态 — 选：两级（常驻 pill → overlay panel），v1 两级都交付（pill 取最小形态）

**候选方案：**
1. **pill（setWidget 常驻状态行）→ overlay panel 两级（对齐 CC footer → TeamsDialog），v1 两级都做** ✅
2. 同 1 但 pill 推迟二期（上一草稿的立场）
3. 直接常驻分栏（打开 pi 即有面板）

**取舍：** 选 1 放弃了：常驻分栏的「一眼全见」（硬约束：pi 无 alternate screen API，dock 布局常驻，强分栏只能挤占编辑器并必然与 TUI 包槽位冲突）；以及草稿方案 2 的更低槽位风险。**推翻草稿 D3「v1 只交付第二级」的理由：用户实现清单第 5 点明示「widget 槽位被占时 auto-yield」——auto-yield 机制属于 v1 交付物**；且 pill 的最小形态（一行状态：running 数 + 提示键位）信息量虽低但为二期 idle/permission 横幅预留了落点。

**风险承担者：** 本包承担 pill 与其他扩展 widget 的共存风险（D7 的检测 + 配置兜底 + 未验证清单）；用户承担 v1 pill 仅显示计数的功能下限。

### D4 v1 范围 — 选：spawn/list/interrupt/stop + transcript 查看 + 通知回注 + pill

**候选方案：**
1. **上述集合** ✅；steer 注入、面板内 spawn composer、task list、mailbox、permission 桥接放二期
2. v1 含 steer（subprocess 架构下需 child 侧 runtime extension + ack 协议，见 D5）
3. handoff 原案（不含 interrupt 与 pill）

**取舍：** 选 1 放弃了：v1 的「可引导」（只能停不能转向）与面板内直接发起 spawn（v1 spawn 走 `/agent-panel spawn` 命令行）。**比 handoff 原案多纳入 interrupt 与 pill 的理由：** interrupt = `proc.kill("SIGINT")` 一行 + 测试（成本≈0，且是 stop 宽限语义的前半段，拆开反而接口不完整）；pill 见 D3。

**风险承担者：** 用户承担 v1 spawn 必须走命令行 / 面板只能观察+停止（handoff 已明示砍范围）；本包承担 interrupt 对 headless child 的实际效果验证（contract/integration test 覆盖，未通过则 v1 文档降级为仅 stop）。

### D5（新增）steer 的 v1 定位 — 选：接口占位 + 协议预留，实现延后

**候选方案：**
1. v1 完整实现 steer：写 `control/steer-requests/*.json`（沿用 pi-subagents 文件协议）+ 随包 child steer-runtime 扩展（轮询 inbox → `pi.sendUserMessage(text, {deliverAs:"steer"})` → 写 ack）
2. **v1 接口含 `steer(id, text): "not-implemented"`，实现抛明确错误** ✅
3. v1 不暴露 steer 接口

**取舍：** 选 2 放弃了：方案 1 的完整能力与方案 3 的「接口永不含未实现方法」洁癖。理由：child runtime 是新增攻击面（要进 child 进程、处理 ack 超时/失配/capability 协商，research.md §1.4 的 delivered-ack 还依赖 `pi.on("input")` 事件关联），不应阻塞主链路验收；但 deep module 的 seam 一次定型（spawn/interrupt/stop/steer 同形），二期补实现不改公开接口。`pi.sendUserMessage` 已官方收录（research.md 勘误 B），二期通道无阻。

**风险承担者：** 本包承担占位接口被二期推翻的小成本；用户承担 v1 steer 缺失（同 D4）。

### D6（新增）child session 文件与租约 — 选：每 child 全新 session 文件，v1 不引入租约

**候选方案：**
1. **每 child 全新唯一 `--session <fresh path>`，存放 `~/.pi/agent/agent-panel/<childId>/session.jsonl`（自有根目录，不进 `~/.pi/agent/sessions/` 以免污染 pi 的 session 索引/picker），v1 无租约** ✅
2. 照抄 pi-subagents session 租约（sha256 目录原子创建 + lstart 身份验证，research.md §1.5）

**取舍：** 选 1 放弃了：跨主会话重启 resume 同一 child 的能力，以及租约的防御纵深。理由：v1 无 revive → 每文件自始至终单写者，租约是死代码；pi-subagents 租约的复杂度（stale 检测 + tombstone）正是「版本漂移打穿」类事故的放大器。二期做 revive 时再引（决策已预留）。

**风险承担者：** 本包承担二期引入租约时的迁移成本；用户承担 v1 关掉 pi 后 child 无法续跑（主进程退出 → dispose kill children，见 lifecycle）。

### D7（新增）widget 槽位共存 — 选：auto-yield 尽力检测 + 配置兜底

**候选方案：**
1. **v1 交付 pill：`ctx.ui.setWidget("agent-panel-status", ...)` 独立 key + auto-yield 检测（`pi.getAllTools()` 的 `sourceInfo` 中发现来自 pi-claude-code-tui 的扩展工具则让位）+ 配置 `pill: "auto"|"on"|"off"` 兜底** ✅
2. v1 零 widget 占用（上一草稿的立场），pill 整体推二期
3. v1 pill 无条件注册，不做检测

**取舍：** 选 1 放弃了：方案 2 的零槽位风险（与草稿 D3 一并被用户实现清单第 5 点否决）；方案 3 的实现简单性。auto-yield 的检测能力有限（`sourceInfo.source === "extension"` 的字段细节官方文档未完全展开，TUI 包是否注册工具未验证）——因此检测只是 fast-path，配置项才是兜底，多 widget 共存行为列入未验证项并在 README 说明。

**风险承担者：** 本包承担检测失准的风险（用户可用配置覆盖）；快捷键选 `alt+p`（pi-effort 已占 `ctrl+shift+e`、pi-subagents 惯用 `shift+tab`/`alt+t` 域；registerShortcut 冲突时 pi 的行为未验证——未验证项，命令入口兜底）。

## 模块设计

### FleetSupervisor（`src/supervisor.ts`）— deep module

```ts
export interface AgentSpec {
  name: string;            // panel display name (also child dir stem)
  prompt: string;
  cwd: string;
  model?: string;          // forwarded as --model
}
export interface AgentHandle {          // read-only plain-data snapshot, render-safe
  id: string;
  name: string;
  state: "starting" | "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  tokens: { input: number; output: number; cost: number };
  toolCount: number;
  sessionFile: string;      // child's own --session JSONL (full history)
  eventsFile: string;       // raw stdout event-line mirror (full set)
  lastLine: string;         // latest assistant text (roster preview)
  currentTool?: string;
}
export type SupervisorEvent =
  | { type: "agent-added"; handle: AgentHandle }
  | { type: "agent-updated"; handle: AgentHandle }
  | { type: "agent-final"; handle: AgentHandle };   // terminal exactly once per child

export interface ProcessRunner {       // internal seam: real spawn vs test fake
  spawn(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }):
    { pid: number; kill(signal?: NodeJS.Signals): void; stdout: AsyncIterable<string> } & Disposable;
}
export class FleetSupervisor {
  constructor(deps: { runner?: ProcessRunner; rootDir?: string; piBinary?: string; limit?: number; now?: () => number });
  spawn(spec: AgentSpec): AgentHandle;        // throws if at limit (default 8) or duplicate live name
  steer(id: string, _text: string): "not-implemented";  // D5: seam placeholder, phase 2
  interrupt(id: string): boolean;             // SIGINT (graceful); false if not running
  stop(id: string): boolean;                  // SIGINT → grace (2s) → SIGKILL; marks stopped
  list(): AgentHandle[];                      // fresh snapshot array (plain copies)
  tail(id: string, maxLines: number): string[]; // read events-file tail, IO-safe (never throws)
  onEvent(cb: (e: SupervisorEvent) => void): () => void;
  dispose(): void;                            // kill all, clear timers; idempotent
}
```

- spawn 管线（research.md §1.3 精简版）：`<piBinary> --mode json -p --no-extensions --no-skills --session <fresh> [--model m] ["Task: ..." | @file]`，`piBinary` 解析顺序 env `PI_AGENT_PANEL_PI_BINARY` → `process.execPath`+pi CLI（`process.argv[1]` 同目录）→ `"pi"` PATH 兜底；prompt > 8000 字符走临时 md `@file`；env 增 `PI_AGENT_PANEL_CHILD=1`；`stdio: ["ignore","pipe","pipe"]`（stderr 尾部保留 4KB ring，终态时落 `stderr.log` 供 post-mortem）。**实现期修正（research.md §5.2）：`--permission-mode` 是扩展注册 flag 而非内建，`--no-extensions` 的 child 会拒收——默认不传，`AgentSpec.permissionMode` 仅显式指定时转发。**
- stdout 处理：逐行 `JSON.parse` 容错非 JSON 行；全行 append `eventsFile`（磁盘全集）；`message_end`(assistant) 聚合 usage（input+output+cacheRead+cacheWrite+cost.total，对齐 execution.ts:750-757）与 lastLine；`tool_execution_start/end` 聚合 toolCount/currentTool。**零行级内存镜像**——每 handle 常驻内存只有上表标量（比 CC 50 条上限更紧，「disk 是全集，live 是后缀」）。
- 终态判定：`agent-final` 恰好发一次。优先级：stop() 干预 → `stopped`；进程 exit 0 且收到 terminalAssistantStop（`message_end` assistant `stopReason==="stop"` 无 toolCall，research.md §1.3）→ `completed`；exit 非 0 → `failed`。exit 与终态消息乱序：exit 后 500ms drain 窗口再定态（对齐 pi-subagents final-drain 模式）。
- 生命周期：不在构造函数里启动任何 watcher（官方要求，research.md §3）；无轮询——事件驱动（stdout 行推进 + 进程 exit），`tail()` 由面板按需调用。
- 单测经 fake ProcessRunner 注入（不碰真进程）；contract/integration test 用真 pi。

### FleetPanel（`src/panel.ts`）— 薄 adapter #1

- 打开：`ctx.ui.custom((tui, theme, _kb, done) => new FleetPanelComponent(tui, theme, supervisor, done), { overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 } })`（fleet.ts:400-408 同参）。
- **render 纯函数（比 fleet.ts 更严）**：`refresh()`（750ms 定时器回调 + 键盘触发）里做 `supervisor.list()` + `supervisor.tail(selected, 200)` 存入组件字段；`render(width)` 只读缓存，**无 ctx、无 IO、无异常路径**。dispose 清定时器。
- 布局：左 roster（38% 宽 clamp 22-46：状态点 + name + tokens + lastLine 截断）+ 右 transcript 尾（wrapTextWithAnsi）；宽 < 36 降级单行提示（fleet.ts:357 同款）。
- 键位：`j/k/↑/↓` 选择（selectedKey 保持跨刷新稳定）、`enter` 聚焦并自动跟随、`PgUp/PgDn` 翻滚（解除跟随）、`x` stop（二次确认：再按 x）、`i` interrupt、`r` 强制刷新、`Esc/ctrl+c/q` 关闭。
- 头部标注包名与活 child 计数；footer 列键位摘要与选中位置。

### NotificationBridge（`src/bridge.ts`）— 薄 adapter #2

- 订阅 `onEvent`，过滤 `agent-final`：`pi.sendMessage({ customType: "agent-panel-notification", content: <一行摘要：name/state/tokens/duration>, display: true, details: {id, name, state, tokens, exitCode, sessionFile, eventsFile} }, { triggerTurn: true, deliverAs: "followUp" })`（对齐 CC `<task-notification>` 模式与 tintinweb 实现，research.md §2.1）。
- 防重：`notifiedIds: Set<string>`（终态恰好一次，与 CC notified 标志同构）。
- 配额：单 session 上限 50 条，超限静默丢弃并计数（防通知风暴）。
- 容错：sendMessage 全程 try/catch，`"Extension context no longer active"` 类错误吞掉（模式抄 index.ts:590-596）；其余错误吞掉并保留 notifiedIds（通知是 best-effort，不得反杀宿主）。

### StatusPill（`src/pill.ts`）— 薄 adapter #3

- 内容：单行 `⏵ agent-panel: N running · M done — alt+p`，running>0 用 accent，全闲用 dim。
- 更新：订阅 supervisor onEvent + 打开/关闭面板时刷新；经 fresh ctx（命令/事件回调携带）调用 `ctx.ui.setWidget("agent-panel-status", line)`，不缓存 ctx。
- auto-yield（D7）：注册前 `shouldYieldPill(pi)` 检查 `pi.getAllTools()` 的 `sourceInfo`（stringify 后含 `claude-code-tui` 即让位）；配置 `~/.pi/agent/agent-panel/config.json` 的 `pill: "auto"|"on"|"off"` 覆盖检测结果。

### 组装（`extensions/index.ts`）

- factory 只做注册（命令/快捷键/session 事件监听），**不启动任何资源**（官方要求）；早退条件 `process.env.PI_AGENT_PANEL_CHILD === "1"`（v1 child 用 `--no-extensions` 不装任何扩展，env 标记是防御纵深）。
- `session_start`：建 Supervisor + Bridge + Pill；`session_shutdown`：`dispose()` + 清 widget（幂等，stale 错误吞掉）。
- `/reload` 防陈旧：globalStore 存 dispose 引用，重复加载先清理（模式抄 pi-subagents index.ts:195-204）。
- `/agent-panel`：无参开面板；`/agent-panel spawn <name> <prompt>` 快捷入口（v1 的 spawn 唯一入口，D4）；`/agent-panel stop <name|id>`。
- 快捷键 `alt+p` 开关面板（D7）。

## 验收标准（全部可验证/可复现）

1. **单测**：`pnpm test` 全绿（node:test + fake ProcessRunner）——覆盖：spawn→starting→running→completed/failed/stopped 状态机、usage/toolCount/lastLine 聚合、非 JSON 行容错、drain 窗口、stop 宽限→SIGKILL、limit/duplicate 拒绝、agent-final 恰好一次、tail 容错、dispose 幂等、steer 占位报错。
2. **contract test**（真实 CLI）：`pi --mode json -p --no-session "Reply with exactly: pong"` 产物断言——首行 `type==="session" && version===3`、每行可 JSON.parse 或标记为容错行、存在 `message_end`(assistant, stopReason 合法)、末尾出现 `agent_settled`（实测基线 research.md §3.1，防 pi 升级漂移）。
3. **integration test**（真实 CLI，node:test 驱动 Supervisor）：spawn 真 child（短 prompt）→ 状态到 completed → agent-final 回调一次 → eventsFile/sessionFile 存在且非空 → stop 场景（长任务 child）状态翻 stopped → exitCode 记录。
4. **扩展加载冒烟**：`pi -e ./extensions --no-session -p "say ok"` 退出码 0、stderr 无未捕获异常（验证 factory 注册路径 + child 早退不炸）。
5. **类型**：`pnpm typecheck`（tsc --noEmit）零错误。
6. **手动交互**（人工，README 记录操作序列）：交互 pi 里 `/agent-panel spawn demo <短任务>` → alt+p 开面板 → 列表出现 ● running → j/k 选择 → enter 看 transcript 增长 → x x 确认 stop → 状态翻 ■ stopped → Esc 关闭 → 主会话收到 agent-panel-notification 回注（triggerTurn 生效：主 agent 被唤醒处理）。
