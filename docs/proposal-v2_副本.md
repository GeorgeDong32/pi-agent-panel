# pi-agent-panel v2 设计提案（对标 CC agent panel v2.1.261）

> 状态：**待用户评审，未实施**。触发：用户用 CC v2.1.261 实测截图反馈——「人家是全屏+随时跳转的」，v1 的「95%×85% 浮窗检查器」形态不达标。
> 本文档是评审稿；定稿后 D8-D10 已预写入 design.md，实施时以此为准并同步更新。

## 0. v1 与 CC 的差距（为什么要有 v2）

| CC v2.1.261 的事实标准（用户截图） | v1 现状 | 差距定性 |
|---|---|---|
| **全屏接管**：列表占满整个视口，底部保留 composer + 键位行 | 95%×85% 浮窗，主会话仍在四周滚动 | 形态性差距 |
| **随时跳转**：enter 跳入会话（"enter to return"）、← 返回列表 | 只有列表右侧小 transcript 栏 | 动线性差距 |
| **Pinned / Working / Completed 分组** + 头部计数（`0 awaiting input · 1 working · 5 completed`） | 平铺列表 + 简单计数 | 观感差距 |
| **列表即调度入口**：底部输入框直接描述新任务（"Describe a task for a new session"） | 只能 `/agent-panel spawn` 命令行 | 定位差距 |
| **space to reply**：列表上直接对选中 agent 说话 | 无（steer 是占位） | 能力缺口 |
| ctrl+x delete（归档，将 session 从 panel 隐藏但不删除 session 对应的 jsonl）、? shortcuts、bypass permissions 徽标 | 有 stop 无 delete；权限徽标无 | 部分缺口 |

## 1. 逐项对位（CC → pi 的实现方式与可行性）

| CC 行为 | pi 上的实现 | 依据 | 可行性 |
|---|---|---|---|
| 全屏接管 | `ctx.ui.custom` overlay：`width:"100%" + maxHeight:"100%" + margin:0` | pi-tui overlay 渲染在整个终端上（tui.js `resolveOverlayLayout` 以 termWidth/termHeight 为基准，只有 margin 收缩可用区；OverlayOptions 类型 tui.d.ts:134-156 实证），100% 即真全屏、盖住 pi dock | ✅ 已验证类型与源码 |
| 分组 + 计数 | Supervisor 状态聚合直接映射：working = starting/running，done = completed/stopped，failed 单独标红 | 现有 AgentHandle | ✅ |
| enter 跳转往返 | 单组件内 `list ⇄ view` 两 mode 状态机（**不做**嵌套 overlay） | CC 旧版实现即「渲染即换消息源」的视图状态机；单组件切换零嵌套、Esc 语义天然分层（view→list→关面板） | ✅ |
| 底部 composer | 面板内自带单行输入（`n` 新任务 / `space` reply/continue），composer 激活时独占键盘 | pi-subagents-lite conversation-viewer 的 steer composer 同款模式（其实证可抄） | ✅ |
| space to reply（steer） | 文件 inbox + child 侧注入 runtime → `pi.sendUserMessage(text, {deliverAs:"steer"})` | 该 API 已被官方文档正式收录（research.md 勘误 B）；pi-subagents 同款协议在生产跑 | ✅ 有新增协议面 |
| continue（结束会话续聊） | 以同一 `--session` 文件再启一个 child；前写者已退出 → 无并发写，v1 无租约的 D6 决策在此恰好成立 | `--session <path|id>` 官方 flag | ✅ |
| ctrl+x delete | `X` 直接移除（live 先 SIGKILL）；Supervisor 新增 `dismiss(id)` | — | ✅ |

## 2. 布局设计

### 2.1 list mode（默认，全屏）

```
╭ agent-panel · 1 working · 5 done ──────────────────────────────╮
│ Pinned                                                         │
│ › ● Dev工作区维护     workspace全绿; 4支rebase成功…  #a1b2  1h │
│     1.2k↑ 15k↓                                                 │
│                                                                │
│ Working                                                        │
│   ● cherry-studio     3 caches ready; rerunning…     #c3d4 20m │
│                                                                │
│ Completed                                                      │
│   ✓ workspace status  Trellis Pi 集成已补装…         #e5f6  1m │
│   ✗ 分支导出增强       PR2 行为层交付完成…           #a7b8  7m │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ jk select · enter open · space reply/continue · n new task ·   │
│ x stop · X delete · p pin · esc close                          │
╰────────────────────────────────────────────────────────────────╯
```

- 行结构对齐 CC：状态点 + 名字 + 最新活动摘要（lastLine）+ 短 id + 相对时间；活 agent 附加 tokens 与当前工具行
- 头部计数：`N working · M done`，有失败时追加红色 `K failed`（CC 的 "awaiting input" 语义我们的一回性任务没有诚实对应物，不硬凑）
- 底部两态：常态=键位提示行（CC footer 同位）；composer 激活=输入行 `› reply: …▌ (enter submit · esc cancel)`

### 2.2 view mode（enter 跳入，全屏）

```
╭ agent-panel · 1 working · 5 done ──────────────────────────────╮
│ ● cherry-studio · running · 1.2k↑ 15k↓ · 7 tools               │
│                                                                │
│ ▶ Task: 调查 cherry-studio 的 cache 失效问题                    │
│ ⚙ read                                                          │
│ 我先看了 config/loader.ts 的 cache 逻辑，发现…                  │
│ ⚙ bash                                                          │
│ （transcript 自动跟随增长；PgUp/PgDn 翻历史）                   │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ enter return · PgUp/PgDn scroll · space reply · esc back       │
├────────────────────────────────────────────────────────────────┤
│ （composer 仍可用：space 直接对它说话）                          │
╰────────────────────────────────────────────────────────────────╯
```

- 头部 = 该 agent 的实时状态行；正文 = 全量事件流的磁盘尾部（tail 800 行窗口）
- `enter`/`Esc` 返回列表——CC 的 "enter to return" 同款往返

### 2.3 键位总表

| 键 | list mode | view mode | composer 激活时 |
|---|---|---|---|
| `j/k` `↑/↓` | 移动选择 | 逐行滚动 | 输入字符 |
| `enter` | 跳入所选 | 返回列表 | 提交 |
| `space` | working→reply composer；done→continue composer | reply composer | 空格 |
| `n` | 新任务 composer | — | — |
| `x` | 停止所选（二次确认 `x x`，footer 红 `x! confirm-stop`） | — | — |
| `X` / `ctrl+x` | 删除所选（live 先 kill，直接移除——对齐 CC 无确认） | — | — |
| `p` | pin/unpin（内存 Set，面板生命周期内有效） | — | — |
| `PgUp/PgDn` | — | 翻页（解除自动跟随） | — |
| `r` | 强制刷新 | — | — |
| `Esc`/`q` | 关面板 | 返回列表 | 取消 composer |
| `ctrl+c` | 关面板 | 关面板 | 取消 composer |

## 3. 架构变化（v2 唯一动协议的部分：steer）

```
主进程 Supervisor.steer(id, text)                child（headless pi --mode json -p）
  └ 写 <childDir>/steer/<reqId>.json   ───────►  child-steer-runtime.ts（~60 行，独立单文件）
     （请求 = {version, requestId, text, ts}）      └ --extension 显式注入（--no-extensions 下
                                                      显式 -e 仍生效，pi --help 实证）
                                                    └ 250ms 轮询 inbox → 读+unlink（消费）
                                                      → pi.sendUserMessage(text, {deliverAs:"steer"})
                                                      → 追加 last-ack.json（{requestId, ok, error?, ts}）
```

设计约束：

- **runtime 独立单文件、零相对依赖**（child 只多载这一个小文件）；env `PI_AGENT_PANEL_STEER_INBOX` 未设即 no-op；`sendUserMessage` 鸭子类型探测（不在则整个 runtime 静默退出）
- **1:1 场景从简**：请求文件 unlink-before-process 即消费语义；ack 只做诊断/测试断言，不做 pi-subagents 式的 capability 文件 + per-request ack 状态机（那是多 child fanout 的可靠性机制，我们直接持有进程句柄，不需要）
- **时机边界**：child 已终态 → `steer()` 返回 `not-running` 面板提示；child 活着 → 请求文件保证在下次轮询被消费（含 spawn 后立即 steer 的竞态：runtime 在 session_start 即 flush 一次）
- continue 复用同一 session 文件，仅允许对终态 child 发起（代码强制，防御第二写者）

## 4. 与 CC 的诚实差距（不掩饰）

1. **跳转 ≠ 驾驶**：CC 跳转后你的输入直接驱动该会话（渲染即换消息源 + 输入路由）；我们的 child 是一次性 headless 任务，跳转 = 全屏观察 + steer（运行中引导）/ continue（结束后接续）。**真·接管**需要长驻 child（`--mode rpc` 或交互驻留 + 输入桥），工程量与风险上一个量级，不在本轮（见 §7 决策点 B）。
2. **awaiting input 计数**：CC 的 agent 会在等用户输入时挂起；我们的一回性任务要么跑要么结束，failed（需关注）单独标红代替，不硬凑 CC 的三段计数。
3. **bypass permissions 徽标**：权限模式回显依赖 permission 桥接（原二期范围），本轮不做。

## 5. 交付物清单（定稿后实施）

| # | 文件 | 变化 |
|---|---|---|
| 1 | `extensions/lib/supervisor.ts` | steer 真实现（写请求文件）、`dismiss(id)`、spawn 支持 `resumeSessionFile`、注入 steer runtime + env、`agent-removed` 事件 —— **底座已改** |
| 2 | `extensions/lib/child-steer-runtime.ts` | 新增（child 侧轮询消费）—— **已建** |
| 3 | `extensions/lib/{types,pi-spawn}.ts` | AgentSpec.resumeSessionFile、buildChildArgs extensions 参数 —— **已改** |
| 4 | `extensions/lib/panel.ts` | **重写**：全屏 + 分组 + list⇄view 状态机 + composer + delete/pin —— 未动（等评审） |
| 5 | `extensions/index.ts` | openFleetPanel 传入 actions（spawnTask/continueTask，ctx 只在打开瞬间被捕获） |
| 6 | 测试 | supervisor 单测增补（steer 写文件/not-running、dismiss、resume args）；panel 单测重写（分组、mode 切换、composer、delete）；integration 增补 steer 链路（真 child ack ok:true） |
| 7 | docs/README | 定稿同步 |

## 6. 当前磁盘状态与回滚

- 已改（未提交）：docs（research §6 / design D8-D10 预写）、supervisor/types/pi-spawn、child-steer-runtime.ts 新文件
- 未动：panel.ts（仍 v1 界面）、全部测试
- 一键回滚：`git checkout -- . && rm extensions/lib/child-steer-runtime.ts`

## 7. 待拍板决策点

**A. 本轮范围**（steer / continue 是否纳入 v2）：
1. **全做**（推荐）——全屏+分组+跳转+composer+steer+continue 一步到位对标 CC 动线；child 侧 +60 行，集成测试覆盖 steer ack
2. steer 上、continue 缓——space to reply 是 CC 动线核心必须上；continue 涉及 session 复用边界，推迟
3. 只改 UI 不动协议——最稳，但 space to reply 缺位则「随时跳转」没有灵魂

**B. 真·会话接管**（跳转后直接驾驶 child）：
1. **先跑 v2，三期再议**（推荐）——需要长驻 child（--mode rpc）+ 输入桥 + 会话生命周期管理，独立立项做可行性
2. 本轮直接上——工程量翻倍，交付时间明显拉长
3. 不需要——一次性任务 + steer/continue 已覆盖使用场景
