/goal [$codebase-design](/Users/gd32/.zcode/skills/codebase-design/SKILL.md) 实施 pi-agent-panel v2（rpc 长驻架构）：把 v0.1.0 的浮窗检查器升级为「全屏 + 随时跳转 + 跳进去就是正常对话」的 agent panel。

## 起点：必读 handoff（先完整读完再动工）
/Users/gd32/Coding/Pi-Extension/pi-agent-panel/docs/handoff-v2.md —— 包含全部已定决策、已实证结论（file:line）、磁盘现状、硬约束、验收标准。这是**实施型任务**：架构与交互已由用户拍板定稿（规格 = docs/proposal-v2.md r3），不要重新调研、不要重新设计；实现中发现规格矛盾或新风险，记录到 design.md 并在交付说明中列出，不要静默改决策。

## 第一步（开工前置）
按 handoff §5 回滚 r1 路线遗留（两条命令），`pnpm test && pnpm test:contract` 回到全绿基线（22+1）后，先做 §6 的 4 个风险闸门探针（RpcClient 导入/args 透传/事件流/全屏+Editor 内嵌），任一失败停下上报。

## 实施范围（规格细节以 proposal-v2.md 为准）
1. FleetSupervisor 重写为 rpc 会话池：长驻 child（`pi --mode rpc`，经宿主包 RpcClient + RpcSessionFactory seam）、prompt/steer/abort/archive、isStreaming 事件推导、turn-end 通知沿（origin 抑制规则）
2. FleetPanel 重写：全屏 overlay（100%/margin 0）+ Working/Awaiting input/Archived 分组 + list⇄view 跳转（←/Esc 返回）+ 常驻 composer（pi-tui Editor 内嵌，CJK/粘贴可用）
3. 键位：x=打断当前轮（agent 存活）、X/ctrl+x=归档（kill+隐藏，JSONL 保留，state.json 持久化）、n=新任务、p=pin
4. NotificationBridge：turn 结束回注（后台 turn 才发；面板内发起/正被查看 → 抑制），防重+配额
5. child 隔离：--no-extensions --no-skills + PI_AGENT_PANEL_CHILD=1；extension_ui_request 主动 deny；limit 默认 4
6. 测试：fake rpc session 单测全覆盖状态机/抑制/归档；contract 不变；integration 用真 rpc child（含同 child 第二轮对话、abort、孤儿自愈）

## 硬约束（违反会出事故，handoff §7 有全文）
- render 闭包禁碰 ctx（stale ctx 杀死 pi）；render 零 IO，快照驱动
- 「disk 是全集，live 是后缀」内存不变量（每 child 只留标量聚合，事件镜像落盘）
- 单测不碰真进程（factory seam）；回复中文、代码注释英文、pnpm、最小改动、不输出密钥

## 交付与验收
1. v0.2.0 提交 + handoff §8 六条验收逐条执行（测试三件套 + typecheck + 冒烟 + 人工序列留 README）
2. design.md 同步定稿（D1 修订/D5、D10 作废/D11 新增）、README/CHANGELOG 更新
3. 明确列出「已验证项与未验证项」+ 人工复现路径（交互式 pi 里 /agent-panel 的操作序列）
