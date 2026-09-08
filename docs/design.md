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

### D1 child 形态与依赖策略 — 选：自研 subprocess spawn 管线（**v0.2.0 修订：长驻 rpc child 经宿主 RpcClient**）

> **v0.2.0 修订（proposal-v2.md r3，用户 2026-09-08 拍板）**：v1 的「一次性 `--mode json -p`」形态被否——跳转后的体验到不了「像正常对话」。v2 起 child = 长驻 `pi --mode rpc`，经宿主包 `RpcClient`（`@earendil-works/pi-coding-agent` 运行时值导入）驱动。这不是引入外部依赖：扩展运行在 pi 进程内，宿主包就是 pi 本身，版本永远与运行中 CLI 一致（pi-claude-code-tui 同款模式生产实证）。备选（照协议自实现 JSONL 收发 ~150 行）保留为 RpcClient 失配时的 fallback，不并行做。事件流仍是 `JsonAgentSessionEvent`（与 `--mode json` 同族），contract test 的 CLI-face 稳定性论证不变。

**候选方案：**

1. 复用 pi-subagents RPC 桥（`subagents:rpc:v1:*` 事件）。
2. in-process AgentSession（tintinweb / lite 路线：`createAgentSession` + `session.steer/abort/subscribe`）。
3. **自研轻量 spawn 管线**（`pi --mode json -p --session <fresh>`，抄 pi-args 模式但只保留 v1 需要的 flag）✅（v0.1.0；v0.2.0 起升级为长驻 rpc，见上）

**取舍：**
- 选 3 放弃了：方案 2 的零成本 steer（session 对象直调）与零成本 live 事件（subscribe 推流）——v1 因此没有 steer（由 D5 占位），事件要自己解析 JSONL。
- 放弃 1 的理由：spawn 强制 detached async + 绑定其 TypeBox schema / async run 目录布局 / executor 接口（research.md §1.6），且用户已被其 0.42→0.55 版本漂移打穿过一次（pi-review CHANGELOG）；跨包事件协议不在本包控制内。
- 放弃 2 的理由（research.md §2.3/§6 实证）：(a) SDK session 面随版本漂移有实锤；(b) in-process child 污染宿主 runtime 有实锤；(c) 与主 TUI 共享进程内存，直接放大 CC 36.8GB 事故的爆炸半径；(d) subprocess 路线下 transcript-on-disk 从诞生即成立，契合「disk 全集、live 后缀」不变量。

**风险承担者：** 本包承担 rpc 事件格式漂移风险 → contract tests 钉住；用户承担 v1 无 steer 的功能缺口（v0.2.0 已由 rpc 原生 steer 补齐）。

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

> **作废记录（v0.2.0，被 D11 取代）**：rpc 路线下 steer 由 pi 官方原生命令覆盖（`RpcClient.steer` / prompt 的 streaming 变体），自研协议整体不再需要。本条保留为决策史。

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

> **v0.2.0 增补（用户对标 CC v2.1.261 实测截图后的方向修正）：** v1 的「95%×85% 浮窗检查器」形态被否——CC 的事实标准是**全屏接管 + 会话间随时跳转 + 列表即调度入口**。D8-D10 记录本轮增量决策；D5（steer 占位）被 D10 推翻拉入 v2。

### D8（v0.2.0）面板形态 — 选：全屏 overlay + 组件内双 mode 状态机

**候选方案：**
1. **全屏 overlay（width 100% / maxHeight 100% / margin 0）+ 单组件内部 `list ⇄ view` 两 mode 切换** ✅
2. 维持 v1 的 95%×85% 浮窗
3. 全屏 + 嵌套第二层 overlay 做 transcript 视图

**取舍：** 选 1 放弃了：浮窗的「与主会话同屏」（正是用户要拿掉的）；方案 3 的实现隔离性。选 1 的依据：pi-tui overlay 渲染在整个终端上，100%+margin 0 即真全屏（research.md §6 实证类型与布局代码）；CC 的「enter 往返」本质就是视图状态机，单组件内 mode 切换零嵌套、零额外 overlay 句柄、Esc 语义天然分层（view→list→关闭），也不需要在组件闭包里二次触碰 ctx.ui（stale-ctx 面）。风险：全屏盖住 pi dock（含 editor/footer）——CC 同样如此（截图底部 editor/footer 是它自己布局的一部分），行为对齐。

**风险承担者：** 本包承担 mode 状态机的键盘路由复杂度；用户接受全屏期间看不到主会话滚动输出（Esc 即回）。

### D9（v0.2.0）「跳转」的语义边界 — 选：全屏 transcript 观察 + steer/continue，如实标注与 CC 的差距

**候选方案：**
1. **enter 进入所选 agent 的全屏 transcript 视图（mode 切换），working 可 s-reply（steer）、completed 可 c-continue（resume 同 session 文件再启 child）** ✅
2. 复刻 CC 的真·会话接管（跳转后用户的输入直接驱动该 agent 会话）
3. 不做跳转，保持列表+右栏

**取舍：** 选 1 放弃了：方案 2 的完整接管体验。硬差距如实记录：CC 的 agent 是长驻会话循环，跳转=切换主 REPL 消息源后直接驾驶它；本包 child 是**一次性 headless 任务**，运行中只能 steer（注入引导），结束后只能 continue（以同一 `--session` 文件再启一个 child 接续对话——进程已退出无第二写者，v1 无租约的 D6 决策在此恰好成立）。选 3 则连 CC 的基本动线都不满足。方案 1 是 subprocess 架构下「随时跳转」的诚实上限；若未来要真接管，需要长驻 child（`--mode rpc`/交互驻留），列入远期。

**风险承担者：** 用户承担「跳转≠驾驶」的期望差（steer/continue 已覆盖 CC 的 space-to-reply 主线）；本包承担 continue 场景的 session 文件并发边界（仅终态后可 continue，代码强制）。

### D10（v0.2.0，推翻 D5）steer — 选：v2 实现（文件 inbox + child runtime 注入）

> **作废记录（v0.2.0 定稿，被 D11 取代）**：本条是 r1（一次性 child）路线的预写决策，实施前路线已切换到长驻 rpc——steer 归 pi 官方 `steer` 命令，`child-steer-runtime.ts` 已删除，未进入任何发布版本。保留为决策史。

**候选方案：**
1. **Supervisor.steer 真实现：写 `<childDir>/steer/*.json` 请求文件；child 经 `--extension <child-steer-runtime.ts>`（`--no-extensions` 下显式 `-e` 仍生效，pi --help 实证）注入 ~40 行 runtime，轮询 inbox → `pi.sendUserMessage(text, {deliverAs:"steer"})` → 写 last-ack.json** ✅
2. 维持 D5 的占位（"not-implemented"）
3. 沿用 pi-subagents 完整协议（capability 文件 + per-request ack + input 事件关联）

**取舍：** 选 1 放弃了：D5 的「不新增 child 侧攻击面」保守立场（用户对标 CC space-to-reply 后，steer 从 nice-to-have 变为主线需求，砍掉它则 D9 的跳转没有灵魂）；方案 3 的多 child fanout 可靠性机制（我们是 1:1 持句柄场景，ack 只做诊断不做状态机）。风险控制：runtime 独立单文件、零相对依赖、env 未设即 no-op、sendUserMessage 鸭子类型探测（沿用 pi-subagents 实证模式，且该 API 已官方收录）；ack 文件仅供集成测试与排障。

**风险承担者：** 本包承担 steer 时机边界（child 已终态则拒绝："not-running"；mid-turn 注入语义由 pi 官方 sendUserMessage 保证）；用户承担 steer 对一次性任务的效果依赖任务性质（类似 CC steer）。

### D11（v0.2.0 定稿）rpc 会话池架构 — 选：长驻 `pi --mode rpc` child + RpcSessionFactory seam

> 来源：proposal-v2.md r3（用户评审+修订+审查通过）。本条取代 D5/D10 的 steer 方案与 D9 的「跳转=只读观察」边界。

**候选方案：**
1. **长驻 rpc child（经宿主包 `RpcClient`）：跳转=真对话、steer/abort/awaiting 全官方原生、NotificationBridge 语义升级为 turn-end** ✅
2. r1 一次性 child（`--mode json -p` + 文件 inbox steer + continue）：工程量小约 50%，但到不了「像正常对话」（proposal §0 对照表）
3. 先 r1 后 r2 分两步：r1 的 steer runtime 投入会被 r2 整体作废

**取舍：** 选 1 放弃了：方案 2 的小工程量与零常驻资源；一次性 child 的「进程跑完即退」资源模型（v2 每个 child 是完整 pi 进程常驻 → limit 从 8 收紧到 4，归档即释放）。关键子决策（proposal §3/§4，全部已拍板）：
- **状态推导事件优先**：`agent_start`/`agent_end` 推 isStreaming（`agent_end.willRetry=true` 不算 turn 结束，避免 retry 间隙闪烁）；spawn 后一次 `getState()` 对齐初态；750ms 定时器只刷 UI。实现期补充：RpcClient 不暴露 exit 回调，空闲期崩溃检测只能靠慢速 liveness 探针（默认 5s 一次 `getState()`，仅判死，不作状态源）——记为对「事件优先」的必要让步。
- **通知抑制双维度**：origin（panel 发起 → 静默）+ view 焦点（正被查看 → 静默）；仅后台 turn 结束回注。crash 一律回注（除正被查看）；archive 永不回注。
- **composer**：pi-tui `Editor` 内嵌（CJK/粘贴/光标免费），运行中提交自动走 steer 语义；crashed/archived agent 的 composer 禁用并提示，`R` 预留 revive 二期入口。
- **child 隔离**：`--no-extensions --no-skills` + `PI_AGENT_PANEL_CHILD=1`；`extension_ui_request`（select/confirm/input/editor 四类等待型）主动回 `cancelled`（经 child stdin 原始 JSONL 行——RpcClient 无公开应答 API，`send()` 会覆写请求 id 且等 30s 超时，故触达私有 process 句柄，收敛在 rpc-session.ts 一处）。
- **归档持久化**：`~/.pi/agent/agent-panel/state.json` 记 archivedIds，跨面板开关/重启保持隐藏（revive 是二期，当前只做隐藏语义与磁盘保留）。
- **模型继承**：spawn 时若可取到主会话模型则一次性转发（`provider/id`），之后 child 自己的 setModel 归 child。
- **孤儿自愈**：实证 rpc-mode stdin EOF → shutdown → exit；父进程无论怎么死管道都关，child 全部自杀，无需清扫器（integration test 断言）。

**风险承担者：** 本包承担 RpcClient 私有面（process.stdin 触达）与宿主包同步演化的风险（同进程同版本，漂移面收敛为「pi 升级时 contract/integration 会先红」）；用户承担常驻内存（默认上限 4 个完整 pi 进程）与 abort 在工具执行中表现为 `stopReason:"error"` 的显示差异。

> **交互修订（2026-09-08，用户实测后提出，三项）**：① list 模式支持 type-to-talk——任何非命令可打印字符（kitty CSI-u 与 legacy 字节皆可）直接开新任务 composer，`n` 保留为显式入口；② 新任务提交后**不再自动跳入对话视图**，留在列表并选中新 agent（`started '…' — enter to open` 提示，任意键消失）；③ view 模式中 composer 为空草稿时 `←` 直接返回列表（此前 `←` 被 composer 吞成光标移动，必须先 esc——空框内移光标无意义）。非空草稿时 `←` 仍移动光标，防误触丢稿。

## 模块设计（v0.2.0）

```
FleetSupervisor    ← deep module，seam 之所在：RpcSessionFactory
                     （生产：rpc-session.ts 包装宿主 RpcClient；测试：fake-rpc.ts 脚本化回放）
                     spawn/prompt/steer/abort/archive/pin/list/tail/onEvent/dispose
                     零 TUI 代码、零 pi 运行时依赖
RpcSession (seam)  ← prompt/steer/abort/getState/stop/onEvent —— 一个长驻 rpc child
FleetPanel         ← 薄 adapter #1：全屏 overlay + list⇄view 状态机 + 常驻 Editor composer
NotificationBridge ← 薄 adapter #2：turn-end 回注 + origin/view 双维度抑制 + 防重 + 配额
StatusPill         ← 薄 adapter #3：三段计数 widget（N working · M awaiting）+ auto-yield
extensions/index.ts← 组装：命令 / 快捷键 / 生命周期 / globalStore 防 /reload / focus 通道
```

### FleetSupervisor（`extensions/lib/supervisor.ts`）— deep module

```ts
export interface AgentSpec { name; cwd; model?; prompt? }   // prompt = 首条消息（background origin）
export type AgentState = "starting" | "working" | "awaiting-input" | "crashed" | "archived";
export interface AgentHandle { /* render-safe 纯数据快照：id/name/state/tokens/toolCount/
  turnCount/sessionFile/eventsFile/lastLine/currentTool/lastActivityAt/pendingCount/pinned */ }
export type SupervisorEvent =
  | { type: "agent-added" | "agent-updated"; handle }
  | { type: "turn-ended"; handle; origin: "panel" | "background" }   // agent_end 且 !willRetry
  | { type: "agent-final"; handle };                                  // crash（恰好一次）
export class FleetSupervisor {
  constructor(deps: { sessionFactory?; rootDir?; limit? = 4; probeMs? = 5000 });
  spawn(spec): Promise<AgentHandle>;          // 起 rpc child + getState 对齐 + 可选首条 prompt
  prompt(id, text, origin?): Promise<boolean>; // 空闲→prompt；working→自动降级 steer；记录 origin
  abort(id): Promise<boolean>;                 // 打断当前轮，agent 存活
  archive(id): Promise<boolean>;               // 隐藏+kill+state.json 持久化；JSONL 保留
  pin(id, pinned?): boolean;
  list(): AgentHandle[];
  tail(id, maxLines): string[];                // IO-safe 事件镜像尾读（格式化行）
  tailEvents(id, maxEvents): { events; dropped }; // IO-safe 原始事件尾读（view 引导）
  onEvent(cb): () => void;
  onChildEvent(cb(id, evt)): () => void;       // 原始事件旁路（view 实时生长）
  dispose(): void;                             // stop 全部 child；幂等
}
```

- 事件三路分发：① 聚合进 handle（tokens/toolCount/lastLine/isStreaming）② `JSON.stringify(evt)` 镜像落 `events.jsonl`（rpc 下镜像 = onEvent 对象再序列化，非原始 stdout 行——RpcClient 不暴露原始行；「disk 全集、live 后缀」不变量不变）③ turn 结束沿 → `turn-ended` 事件。
- 状态推导（D11）：`agent_start` → working；`agent_end && !willRetry` → awaiting-input + turn-ended；spawn 后一次 `getState()` 对齐初态；liveness 探针（默认 5s）只用于空闲期死亡检测。
- child 目录 `~/.pi/agent/agent-panel/<id>/`：`session.jsonl`（child 自写全集）、`events.jsonl`（镜像）、`crash.log`（崩溃原因）；归档集在 `~/.pi/agent/agent-panel/state.json`。
- 单测经 fake RpcSessionFactory（`test/unit/fake-rpc.ts` 脚本化事件回放）；真进程只出现在 integration/contract。

### rpc-session.ts — 真 adapter（RpcClient 包装）

- `resolvePiCliPath()`（pi-spawn.ts）：env `PI_AGENT_PANEL_PI_BINARY` → pi 宿主 argv[1]（校验属于 pi 包）→ 已安装包 bin；**必须解析出 node 可执行脚本**（RpcClient 固定 `spawn("node", [cliPath, ...])`），PATH 上的 wrapper 二进制不可用——解析失败在 spawn 时抛明确错误。
- options：`{ cliPath, cwd, env: {PI_AGENT_PANEL_CHILD=1}, args: ["--no-extensions","--no-skills","--session",<file>], model? }`。
- `extension_ui_request` 主动 deny：等待型四类（select/confirm/input/editor）立即向 child stdin 写 `{"type":"extension_ui_response","id":…,"cancelled":true}` 原始 JSONL 行（见 D11 私有面说明）；面板 transcript 显示 `⚠ child ui request denied: <title>`。

### FleetPanel（`extensions/lib/panel.ts`）— 薄 adapter #1

- 打开：`ctx.ui.custom(..., { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } })` —— 全屏盖住 pi dock。
- **render 纯函数**：`refresh()`（750ms 定时器 + 键处理上下文）做 `list()`；`render(width)` 只读缓存与组件内 Editor，无 ctx、无 IO、无异常路径。
- list mode：头部三段计数（N working · M awaiting input · K archived）+ 分组行（Pinned/Working/Awaiting input/Archived，crashed 归 Archived 组红 ✗）。
- view mode：头部 agent 详情行 + **原生对话渲染**（ConversationView）+ 常驻 composer。
- composer：pi-tui `Editor` 内嵌（identity selectList 主题——无 autocomplete 路径不触发；paddingX 1）。输入焦点模型：view mode 下 nav 键（j/k/PgUp/PgDn/x/enter/space/←/esc）归面板，其余可打印字符激活 composer（type-to-talk）；composer 激活时一切输入归 Editor，esc 取消草稿。
- 键位（proposal §2.3 全表）：list `j/k ↑/↓` 选择 · `enter` 跳入 · `space` 跳入+聚焦 composer · `n` 新任务 composer（首行派生名字，enter = spawn+跳入）· `x` 打断当前轮 · `X`/`ctrl+x` 归档 · `p` pin · `esc/q` 关闭；view `enter/space` 聚焦 composer · `j/k` 逐行滚动 · `PgUp/PgDn` 翻页 · `x` 打断 · `←`/`esc` 返回列表 · `R` 预留 revive 提示。
- crashed/archived agent 的 view：composer 禁用 + 提示 + session 文件路径（`R` 提示二期）。

### D12（2026-09-08）takeover/detach —— enter 的语义升级为「主 REPL 接管会话」

用户诉求「enter 打开的就是正常 pi」。源码实证：pi 在 ExtensionCommandContext 上提供 `switchSession(sessionPath, { withSession })`（interactive-mode 走 handleResumeSession → 完整会话重建 + UI 重建）。**模型：session 文件 = 会话的真相，进程只是临时的驱动器**：

- **takeover（list 上 enter）**：panel done 回传 `{takeover: id}` → 命令层 `supervisor.takeover(id)`（停 rpc child，记录标 `attached`，不发 agent-final）→ `ctx.switchSession(child.sessionFile)` → 主 REPL 本尊 resume 该会话（完整 CC-TUI 皮肤/编辑器/命令）。失败回滚：switch 抛错则自动 detach 回去，会话不滞留。
- **detach（attached 行上 d）**：`supervisor.detach(id)`（删旧记录、`spawn({resume: sessionFile})` 重生 rpc child——childDir/events.jsonl 原地复用，镜像连续）→ `ctx.switchSession(lastMainSessionFile)` 切回主会话。跳回目标链式记忆：session_start(new/resume/fork) 的 `previousSessionFile`。
- **生命周期分化（关键坑）**：switchSession 的 teardownCurrent 会发 `session_shutdown`——原 handler 无条件 dispose 会杀掉整个 fleet。现按 reason 分化：仅 `quit`/`reload` 清理；`new`/`resume`/`fork` 保留 fleet 并重绑 ctx/pill。
- **边界**：switchSession 只在命令 ctx 上（RegisteredCommand.handler），alt+p shortcut 的 ctx 无此方法 → takeover/detach 仅 `/agent-panel` 路径可用，shortcut 路径 notify 引导。takeover 后该 agent 由主 REPL 驱动，用主会话的模型配置（非 child 原模型）——与「驱动器可换」哲学一致。attached 不持久化（宿主重启后视为 archived， revived 属二期）。
- ConversationView（space 快看）保留为轻观察层：不接管、纯渲染，与 takeover 分层。
- **入口补充（2026-09-08）**：`registerShortcut("left")` + handler 内 `ctx.ui.getEditorText()` 判空——空框开 panel（CC「← for agents」原味语义，getEditorText 跟随活编辑器、fork 皮肤下亦然）；非空放行（ctrl+b 是 pi 默认光标左移等价键）。`registerShortcut("shift+left")` 无条件打开作为冗余入口。**→ 镜像（detach 快捷键）**：空框 + 当前主会话属于某 attached agent → `pi.sendUserMessage("/agent-panel detach <id>", { expandPromptTemplates: true })` 派发命令——sendUserMessage 的命令派发（`_tryExecuteExtensionCommand`）给动作一个 fresh 命令 ctx，绕开「shortcut ctx 无 switchSession」边界；配套新增 `/agent-panel detach [name|id]` 子命令（缺省=当前会话对应的 attached agent，次选唯一 attached）。**代价**：覆盖内建编辑器键让 pi 每次 runtime 重建显示 `[Extension issues]` 信息横幅（runner.js:378 restrictOverride=false 路径，扩展胜出并警告）；消除法是用户 keybindings 把 cursorLeft/Right 改绑纯 ctrl+b/ctrl+f。裸 `←` 不可行：extension shortcut 在编辑器 handleInput 最前匹配且无「输入为空」条件（CC 有 Footer 上下文），会废掉光标移动；alt+left/ctrl+left 被 `tui.editor.cursorWordLeft` 占用；shift+left 全空且 custom editor（CC-TUI fork）桥接 `onExtensionShortcut`（interactive-mode 2117）。shortcut 路径打开的 panel 里 takeover/detach 仍降级提示（switchSession 仅命令 ctx）。

### ConversationView（`extensions/lib/conversation.ts`）— 原生对话渲染

- **动机（2026-09-08，用户实测「不能像 CC 那样跳到正常 session 界面」）**：对照 CC 源码（/Users/gd32/Coding/claude-code/src）实证其 agent panel 机制——没有独立 panel 组件，`REPL.tsx:4509` `displayedMessages = viewedAgentTask.messages`，同一个 `<Messages>` 渲染器换消息源；进入时 disk bootstrap（retain + 读盘合并去重），查看时输入框提交 = steer/续跑（`onAgentSubmit`）。pi 的 child 是独立 OS 进程、宿主 REPL 无消息源 seam，字面复刻不可行；但**渲染保真度**可行：view 直接用 pi 导出的同名组件画 child 的会话流。
- 回放规则（镜像 interactive-mode rebuild 路径）：`message_end(user)` → `UserMessageComponent`；`message_end(assistant)` → `AssistantMessageComponent` + 每个 toolCall 一张卡；`tool_execution_start` → `ToolExecutionComponent` 实时出现；`tool_execution_end` → `updateResult`（乱序时结果先存 `finishedResults`，卡片后建时补挂）；`cardIds` 集合保证一个 callId 至多一张卡。
- 主题：组件读 pi 全局 theme（`getMarkdownTheme()` 与组件内 singleton），与主 REPL 同源同色。pi 的 exports map 不导出内建工具渲染器（read/bash/edit 深层导入被 ERR_PACKAGE_PATH_NOT_EXPORTED 挡）→ 工具卡走组件自带 fallback（粗体工具名 + 参数 + 输出预览）。
- 引导时序：`enterView()` 同一 tick 内先 `tailEvents(id, 400)` 引导、再 `onChildEvent` 订阅——JS 单线程下零丢失零重复；引导截断显示「… N older events not shown」提示。渲染按宽度缓存，apply 才失效。
- 单测注意：组件渲染期读全局 theme，测试环境需先 `initTheme(undefined, false)`（conversation/panel 测试已加）。

### NotificationBridge（`extensions/lib/bridge.ts`）— 薄 adapter #2

- 触发点 v2 = `turn-ended`（非 v1 的进程终态）；抑制规则（D11）：origin=panel → 静默；focus.current=该 agent → 静默；其余回注 `pi.sendMessage(..., { triggerTurn: false })`，内容含 sessionFile。**行为修订（2026-09-08 pty 实证）**：`triggerTurn: true` 会让主会话对每条通知真的启动一轮 LLM 响应（capture 里主 agent 自跑 bash 应答）——观感即用户报告的「重复通知卡片」；改为 `triggerTurn: false`（idle→纯 append，streaming→turn 尾 flush append，两种状态都不驱动 LLM，sendCustomMessage 交付矩阵核实过），对齐 CC task-notification「可见但打断主循环」语义。另：pty 分帧统计（883 帧单帧均 1 次）证明渲染层无双显 bug。
- `agent-final`（crash）：除正被查看外一律回注（用户需要知道后台 agent 死了）；archived 永不回注。
- 防重：`notifiedTurns` keyed by `<id>:<turnCount>`（每 turn 至多一次）；配额 50；sendMessage 全程 try/catch。
- focus 通道：`PanelFocus { current: string | null }` 由 index.ts 持有，Panel 写（view 进入/离开/关闭）、Bridge 读。

### StatusPill（`extensions/lib/pill.ts`）— 薄 adapter #3

- 内容：`⏵ agent-panel: N working · M awaiting — alt+p`（working accent / awaiting success）；全闲 dim。
- 更新：主会话 `tool_result` + supervisor `onEvent` 双触发（v2 增：child 活动即刷新，不必等主会话动作）；经 lastCtx 调 `ctx.ui.setWidget`，不缓存 stale ctx。
- auto-yield（D7 不变）。

### 组装（`extensions/index.ts`）

- factory 只做注册，不启动资源；早退 `PI_AGENT_PANEL_CHILD === "1"`。
- `session_start`：Supervisor + focus + Bridge + Pill + pill 事件刷新订阅；`session_shutdown` / globalStore 防 `/reload`（幂等）。
- 命令：`/agent-panel`（开面板）、`/agent-panel spawn <name> <prompt...>`（spawn+首条 prompt，主会话模型一次性转发）、`/agent-panel archive <name|id>`（`stop` 保留为别名）。
- 快捷键 `alt+p`（D7；命令入口兜底——Mac 终端 Option-as-Meta 配置差异见 README）。

## 验收标准（v0.2.0，全部可验证/可复现）

1. **单测**：`pnpm test` 全绿（fake rpc session）——覆盖：spawn→starting→(getState 对齐)→awaiting、agent_start/end 状态机（含 willRetry 不结束 turn）、prompt 空闲/working 自动 steer 降级 + origin 透传、abort 语义、归档（隐藏+stop+state.json+幂等+事件忽略）、crash（探针失败/发送失败→agent-final 恰好一次）、limit 4、重名、pin、dispose 幂等、镜像 tail 与 denied 行、抑制矩阵（origin/focus/dedupe/配额/crash/archive）、面板 list⇄view/composer(CJK/取消/type-to-talk)/x/X/p/焦点通道。
2. **contract test**：不变全绿（`--mode json` 事件流钉子；rpc 与 json 同族事件，钉子同样护住 rpc 解析面）。
3. **integration test**（真 rpc child）：同 child 第二轮对话（真对话核心）、运行中 abort 后 agent 存活可续问、归档后 `pgrep` 无匹配残留进程、孤儿自愈（stdin EOF → 限时退出）。
4. **扩展加载冒烟**：`pi -e ./extensions --no-session -p "say ok"` 退出码 0、stderr 干净。
5. **类型**：`pnpm typecheck` 零错误。
6. **手动交互**（人工，README 记录序列）：`/agent-panel` 全屏 → `n` 输中文任务 → enter 跳入 → 流式输出 → composer 追问（第二轮真对话）→ `←` 返回 → `x` 打断长任务 → `X` 归档 → 关 pi 后无残留进程。
