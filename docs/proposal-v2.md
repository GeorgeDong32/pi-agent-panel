# pi-agent-panel v2 设计提案（修订 r3：rpc 长驻架构路线）

> 状态：**待用户评审，未实施**。r1 触发：用户用 CC v2.1.261 实测截图反馈——「人家是全屏+随时跳转的」。
> r2 触发：用户追问关键疑点——「enter 跳转到 session 能像 claude 一样像正常的对话一样吗？」→ 由此实证了 pi `--mode rpc` 长驻模式，**答案从「不能」翻转为「能」**。
> r3：自审补 8 处缺口（见 §8 审查记录）：通知抑制规则、x 键语义、孤儿进程实证、composer 输入质量（CJK/粘贴）、child 隔离参数、状态推导方式、资源上限、crashed UX。
> 已融合用户对 r1 的修订：← 返回列表、ctrl+x = 归档（不删 JSONL）。

## 0. 直接回答：跳转后能像正常对话一样吗？

**分两种架构，结论相反：**

| | r1 方案：一次性 child（`--mode json -p`） | **r2 方案：长驻 child（`--mode rpc`）** |
|---|---|---|
| 跳转后的体验 | 只读 transcript + 单行 composer 的 steer 注入，child 跑完即退 | **真对话**：composer 提交 = `prompt()` 真开一轮 → 流式回显 → 答完继续问，turn-taking 与正常 pi 对话同构 |
| 你的输入是什么语义 | steer 引导（child 可能正跑在任务半中间） | 正常 prompt（agent 空闲时=新对话轮；运行中可用原生 steer/followUp） |
| 对话历史 | child 退出后只能 continue 重启 | 常驻累积，跳进跳出上下文始终在 |
| awaiting input 语义 | 无诚实对应物 | **有**：`RpcSessionState.isStreaming === false` 即空闲等输入，`pendingMessageCount` 即排队数（CC 三段计数的诚实对应物出现了） |
| steer / abort / 权限请求 | 文件 inbox 自研协议 | 全部 rpc 原生命令；child 扩展要 UI 时发 `extension_ui_request` 给父进程——**permission 桥接的官方通道**（二期） |

**结论：r1 的一次性架构到不了「像正常对话」，r2 的 rpc 架构能。** 代价是 Supervisor 从「一次性进程管理」升级为「长驻会话管理」，详见 §3。

## 1. rpc 路线的实证基础（pi 0.85.1 安装包逐条核验）

- `--mode rpc`：官方三输出模式之一（`pi --help`：text / json / rpc），自述「Used for embedding the agent in other applications」——**CC agent panel 的同款模型（长驻 agent 会话池）在 pi 是一等公民**。
- **`RpcClient` 官方 SDK 类**（dist/index.d.ts:27 导出）：`start/stop/prompt/steer/followUp/abort/clearQueue/newSession/getState/setModel/setThinkingLevel/setSteeringMode/onEvent/getStderr`——stdin/stdout JSONL 协议、请求关联、进程管理全部现成。
- **命令全集**（rpc-types.d.ts RpcCommand）：`prompt`（带 `streamingBehavior: "steer"|"followUp"` 变体）/ `steer` / `follow_up` / `abort` / `clear_queue` / `new_session` / `get_state` / `set_model` / `set_thinking_level` / `set_steering_mode` / `compact` / `set_auto_compaction` 等。
- **事件流 = `JsonAgentSessionEvent`**：与 `--mode json` 同族（message_start/update/end、tool_execution_*、agent_end…）——transcript 渲染与 contract test 全部复用，CLI-face 稳定性论证不变。
- **`RpcSessionState`**：`isStreaming / isCompacting / sessionFile / sessionId / messageCount / pendingMessageCount / model / thinkingLevel`——列表分组与头部计数的数据源齐全。
- **`extension_ui_request`**（rpc-types.d.ts:397-412）：select/confirm/edit 三类——child 内扩展弹 UI 时转父进程应答，二期 permission 桥接走此通道。

**依赖形态说明（对 D1 的修订）**：`RpcClient` 从宿主包 `@earendil-works/pi-coding-agent` 运行时导入。这不是引入外部依赖——扩展运行在 pi 进程内，宿主包**就是 pi 本身**，版本永远与运行中 CLI 一致（pi-claude-code-tui 已大量同款模式在跑，零漂移实证）。备选：照协议自实现 JSONL 收发（~150 行），保持零导入——作为 RpcClient 失配时的 fallback，不并行做。

## 2. 布局设计

### 2.1 list mode（默认，全屏）

```
╭ agent-panel · 1 working · 4 awaiting input · 2 archived ───────╮
│ Pinned                                                         │
│ › ● Dev工作区维护     workspace全绿; 4支rebase成功…  #a1b2  1h │
│     1.2k↑ 15k↓                                                 │
│                                                                │
│ Working                                                        │
│   ● cherry-studio     3 caches ready; rerunning…     #c3d4 20m │
│                                                                │
│ Awaiting input                                                 │
│   ✓ workspace status  Trellis Pi 集成已补装…         #e5f6  1m │
│                                                                │
│ Archived                                                       │
│   ✗ 分支导出增强       （已归档，会话文件保留）        #a7b8  7m │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ jk select · enter open · space reply · n new task · x stop ·   │
│ X archive · p pin · ← return · esc close                       │
╰────────────────────────────────────────────────────────────────╯
```

- 分组（rpc 语义重定义）：**Working** = isStreaming；**Awaiting input** = 空闲等输入（CC 三段计数的诚实对应物）；**Archived** = 用户归档或进程崩溃退出的；failed/crashed 红点单独标
- 行结构：状态点 + 名字 + 最新活动摘要（lastLine）+ 短 id + 相对时间；活 agent 附加 tokens 与当前工具
- 头部计数 = `N working · M awaiting input · K archived`（对齐 CC 三段）

### 2.2 view mode（enter 跳入，全屏对话视图）

```
╭ agent-panel · 1 working · 4 awaiting ──────────────────────────╮
│ ● cherry-studio · working · 1.2k↑ 15k↓ · 7 tools               │
│                                                                │
│ ▶ 调查 cherry-studio 的 cache 失效问题                          │
│ 我先看了 config/loader.ts 的 cache 逻辑，发现…                  │
│ ⚙ read  config/loader.ts                                       │
│ 问题出在 X，我建议 Y…（流式增长）                                │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ › 把重点改到 cache 失效场景▌                  (enter · esc)    │
├────────────────────────────────────────────────────────────────┤
│ enter/← return · PgUp/PgDn scroll · esc back                   │
╰────────────────────────────────────────────────────────────────╯
```

- **对话视图**：用户消息 `▶`、助手全文、工具调用折叠行（`⚙ tool args`）；streaming 中自动跟随，PgUp/PgDn 翻历史
- **composer 常驻**（这是与 r1 的本质区别）：提交即 `prompt()`；agent 运行中提交则走 steer（rpc 原生 `streamingBehavior`）——同一输入框，语义自动正确，正是 CC「像正常对话」的手感
- `←` 返回列表（用户修订，Esc 同效兜底）

### 2.3 键位总表

| 键 | list mode | view mode | composer 激活时 |
|---|---|---|---|
| `j/k` `↑/↓` | 移动选择 | 逐行滚动 | 输入字符 |
| `enter` | 跳入所选 | （composer 提交） | 提交 |
| `space` | 快捷开 reply composer | 快捷聚焦 composer | 空格 |
| `n` | 新任务 composer | — | — |
| `x` | **打断所选 agent 当前轮**（rpc `abort`，等价主会话 esc-to-interrupt；agent 本体存活） | 打断当前轮 | — |
| `X` / `ctrl+x` | **归档**：从 panel 隐藏并 kill 该 agent（SIGTERM→宽限→SIGKILL），session JSONL 保留在磁盘——用户修订 | — | — |
| `p` | pin/unpin | — | — |
| `PgUp/PgDn` | — | 翻页（解除自动跟随） | — |
| `←` | — | **返回列表**（用户修订；Esc 同效） | — |
| `Esc`/`q` | 关面板 | 返回列表 | 取消 composer |

## 3. 架构：Supervisor 从「进程运行器」升级为「会话池」

```
FleetSupervisor（deep module，接口不变量保持：spawn/steer/interrupt/stop/list/onEvent/archive）
  child = 长驻 `pi --mode rpc [--session <file>]` 进程
  seam = RpcSessionFactory（生产：包装宿主 RpcClient；测试：fake session，脚本化事件回放）
  ── prompt(id, text) → command {type:"prompt"}；streaming 期间自动降级为 steer 语义（streamingBehavior）
  ── onEvent → 事件流三路分发：① 聚合进 AgentHandle（tokens/toolCount/lastLine/isStreaming）
                                ② 全行镜像 events.jsonl（disk 全集，live 后缀不变量不变）
                                ③ turn 结束沿 → NotificationBridge 回注主会话（对齐 CC task-notification）
  ── 状态机：starting → working(isStreaming) ⇄ awaiting input；crashed(进程死)；archived(用户)
```

关键设计点：

1. **一次性任务用例依然覆盖**：`spawn(name, prompt)` = 起长驻 child + 立即发首条 prompt；turn 结束 = 「任务完成」→ 通知回注（与 v1 行为对齐），但 agent 不退出——随时跳进去追问。
2. **steer runtime 方案作废**：rpc 原生 `steer` 命令完全覆盖 r1 的文件 inbox + child-steer-runtime.ts 方案（已建的该文件与 supervisor 改动将回滚）。协议面归零，收归 pi 官方维护。
3. **session 持久化与恢复**：child 带 `--session <file>` 启动（RpcClient `args` 透传）；child 崩溃 → 从 session 文件重启重建状态（二期可做 revive；单写者由「先确认进程死再重启」保证，D6 无租约决策仍成立）。
4. **D1 修订**：运行时导入宿主包的 `RpcClient`（§1 论证：宿主包=pi 本身，无版本漂移）；`RpcSessionFactory` seam 保证单测不碰真进程；若导入面失配，fallback 自实现 JSONL 协议（协议同为 CLI face）。
5. **归档**（用户修订）：`archive(id)` = 从列表隐藏 + kill（SIGTERM→宽限→SIGKILL，RpcClient.stop() 同链）；`~/.pi/agent/agent-panel/<id>/`（session.jsonl / events.jsonl）不删除，可用 `pi --session <file>` 随时找回。归档集合持久化到 `~/.pi/agent/agent-panel/state.json`，跨面板开关保持隐藏。
6. **孤儿进程自愈（已实证）**：rpc-mode 监听 `process.stdin.on("end")` → shutdown 退出（rpc-mode.js:644,581-597）。主 pi 进程无论怎么死（含终端直接关闭），stdin 管道关闭 → 全部 child 自杀，**无孤儿、无需启动清扫器**。正常路径 `session_shutdown` → dispose 走 stop() 优雅链。
7. **通知抑制规则（新增，防通知风暴）**：turn 结束 ≠ 一律回注。规则：(a) 该 turn 由用户在面板内发起（composer 提交记录的 origin）→ 不回注，你正在驾驶它；(b) 该 agent 正被面板查看（view mode 焦点）→ 不回注；(c) 面板关闭或查看其他 agent 时的后台 turn 结束 → 回注。Bridge 需从 Panel 接收 origin/focus 提示（supervisor 事件带 origin 字段：`prompted-in-panel` / `background`）。
8. **child 隔离参数（明确）**：rpc child 经 `options.args` 仍带 `--no-extensions --no-skills`（干净环境、启动快），经 `options.env` 注入 `PI_AGENT_PANEL_CHILD=1`（防本扩展经任何途径递归载入 child）；child 内扩展触发 `extension_ui_request` 时**主动回 deny**（不挂起等超时），面板如实显示「child 权限请求被拒」。权限桥接（select/confirm 转发到面板）二期。
9. **composer 输入质量（新增）**：不用裸 char-append（对 CJK/IME 组合输入、终端粘贴不可靠）；composer 基于宿主 pi-tui 的 `Editor` 组件内嵌（lite 的 conversation-viewer 实证该路径可行），获得 CJK/多行/粘贴/光标移动。Editor 不满足单行形态时降级自绘但必须整 UTF-8 码点处理。
10. **状态推导（事件优先，不轮询）**：turn 边界用事件流的 `agent_start`/`agent_end` 推导 isStreaming（与 json 模式同族事件），仅在 spawn 完成后调一次 `getState()` 对齐初态（sessionFile/sessionId/model）；750ms 定时器只做 UI 刷新，不做状态源。
11. **事件镜像措辞修正**：rpc 下镜像行 = `onEvent` 收到的 event 对象再序列化（非原始 stdout 行；RpcClient 不暴露原始行）。「disk 全集、live 后缀」不变量不变，`tail()` 渲染逻辑复用。

## 4. 与 CC 的剩余差距（rpc 架构下已收敛到的诚实边界）

1. **编辑器**：view mode 的输入是面板内 composer，不是 pi 主编辑器（无多行/历史/补全）。CC 的 panel composer 同为轻量输入——差距可接受；若要完全一致，二期可评估 `setEditorComponent` 桥接。（composer 基于 pi-tui Editor 构建，CJK/粘贴可用，见 §3.9）
2. **权限请求**：rpc 通道已就位（extension_ui_request），本轮不做桥接——child 内请求被主动 deny 并如实显示；select/confirm 转发到面板属二期。
3. **跨 pi 重启 revive**：session 文件都在，但「重启 pi 后把长驻 child 全部拉起」列二期。crashed/已退出 agent 在 view mode 中 composer 禁用并提示，`R`（大写）预留为「从 session 文件重启」的二期入口。
4. **资源上限**：每个长驻 child 是一个完整 pi 进程（Node + agent runtime）。limit 默认从 8 收紧到 **4**（可配置），README 明示内存量级与「归档即释放」；这是一次性 v1（进程跑完即退）与长驻 v2（常驻占用）的本质区别，CC 36.8GB 事故的教训在长驻模型下更相关。
5. **模型默认继承**：child 读同一 `~/.pi` 全局配置，默认模型一致；但主会话**临时切换**的模型不会继承——spawn 时若主会话 model 与默认不同，经 `options.model` 显式转发（一次性，之后 child 自己的 setModel 归 child）。

## 5. 交付物清单（r2 定稿后实施）

| # | 文件 | 变化 |
|---|---|---|
| 1 | `extensions/lib/supervisor.ts` | **重写**为 rpc 会话池：RpcSessionFactory seam、prompt/steer/abort/archive、isStreaming 状态机、turn-end 沿事件 |
| 2 | `extensions/lib/rpc-session.ts` | 新增：RpcClient 包装（cliPath 解析沿用 getPiSpawnCommand、args 透传 --session/--model） |
| 3 | `extensions/lib/{types,pi-spawn}.ts` | AgentHandle 增 isStreaming/phase；rpc 模式 args 构建（回滚 r1 的 resumeSessionFile/extensions 注入） |
| 4 | ~~`extensions/lib/child-steer-runtime.ts`~~ | **删除**（rpc 原生 steer 取代） |
| 5 | `extensions/lib/panel.ts` | **重写**：全屏 + §2 布局 + list⇄view 状态机 + 常驻 composer + archive/pin |
| 6 | `extensions/lib/bridge.ts` | 触发点改 turn-end；通知内容含 sessionFile |
| 7 | `extensions/index.ts` | actions 适配（spawnTask=spawn+首条 prompt） |
| 8 | 测试 | 单测换 fake rpc session（脚本化事件回放：对话轮/steer/崩溃恢复/归档）；contract test 不变；integration 改真 rpc child（prompt→turn-end→再 prompt） |
| 9 | docs/README | 定稿同步（design.md D1 修订、D5 作废记录、新 D11 rpc 架构） |

## 6. 当前磁盘状态与回滚

- 已改（未提交）：docs（research §6 / design D8-D10 预写，r2 定稿后统一校正）、supervisor/types/pi-spawn（r1 steer 底座）、child-steer-runtime.ts（r1 方案，**r2 下作废**）
- 未动：panel.ts（仍 v1）、全部测试
- r2 路线下的清理：`git checkout -- . && rm extensions/lib/child-steer-runtime.ts`（回 v0.1.0 干净态，rpc 底座重新落）

## 7. 待拍板决策点（r2 重述）

**唯一的架构决策：child 形态。**

1. **长驻 rpc（r2 推荐）**——跳转即真对话（§0），steer/abort/awaiting 语义全官方原生，NotificationBridge 语义更准；代价：Supervisor 重写为会话池 + fake rpc session 测试面，工程量比 r1 方案大约 +50%，一次性任务用例完整保留
2. r1 一次性方案（文件 inbox steer + continue）——工程量小、改动面小，但**明确到不了「像正常对话」**（§0 表），且 steer runtime 属于将来被 rpc 取代的自研协议投入
3. 先 r1 后 r2 分两步——r1 的 steer runtime 投入会被 r2 整体作废，不推荐

**随 A 附带确认的小项**（如无异议按默认执行）：
- ← 返回列表（用户修订，Esc 同效）✅
- ctrl+x = 归档不删 JSONL，归档集持久化 ✅
- 分组命名用 Working / Awaiting input / Archived（CC 三段对位）✅

## 8. r3 审查记录（自审发现的 8 处缺口及处置）

| # | 缺口 | 风险 | 处置（已并入正文） |
|---|---|---|---|
| 1 | **通知抑制规则缺失**：r2 的「turn 结束一律回注」在对话式 agent 下会通知风暴——你在面板里追问一句，答完又弹一条到主会话 | 高（核心体验） | §3.7：origin（面板发起/后台）+ view 焦点双维度抑制 |
| 2 | **x 键语义歧义**：r2 键位表「x 停止 agent」在长驻架构下错位——打断 ≠ 杀死 | 高（误杀对话） | §2.3：x = abort 当前轮（agent 存活）；X = 归档（kill），职责分离 |
| 3 | **孤儿 child**：主进程被硬杀（关终端）后长驻 child 何去何从未设计 | 高（残留进程） | 已实证自愈：rpc-mode stdin EOF → 自杀（rpc-mode.js:644,581），无需清扫器；§3.6 |
| 4 | **composer 输入质量**：裸 char-append 对 CJK/IME 组合输入与终端粘贴不可靠（用户中文输入是主路径） | 高（中文用户） | §3.9：composer 基于 pi-tui Editor 内嵌（lite 实证路径） |
| 5 | **child 隔离参数未写明**：rpc child 若做 extension discovery 会载入用户全局扩展（含本包自身→递归） | 中 | §3.8：--no-extensions --no-skills + CHILD_ENV；extension_ui_request 主动 deny（不挂起） |
| 6 | **状态推导方式含糊**：r2 写了 isStreaming 但没说从哪来，易做成 750ms 轮询 getState | 中（架构洁癖+延迟） | §3.10：agent_start/agent_end 事件推导，spawn 后一次 getState 对齐；§3.11 事件镜像措辞修正 |
| 7 | **资源上限未重估**：limit=8 是一次性进程的默认；长驻=8 个完整 pi 进程常驻 | 中（内存） | §4.4：默认收紧到 4 + 文档化；归档即释放 |
| 8 | **crashed/退出 agent 的 view UX 空白**：跳进一个已死 agent 时 composer 还能提交吗 | 低 | §4.3：composer 禁用 + 提示，`R` 预留 revive 二期入口 |

审查时核验过但**不需要改设计**的点：RpcClient 以 `spawn("node", [cliPath, ...args])` 起进程、`options.args/env` 完整透传、stop() 即 SIGTERM→SIGKILL 链（rpc-client.js:32-98）——§5 的 rpc-session 包装参数面成立。
