# Changelog

## Unreleased (2026-09-08, evening)

- **Takeover/detach — `enter` now opens the agent as a real, full-skin pi
  session** (user feedback: "can't jump into a normal session like CC").
  The model: the session file is the source of truth, processes are just
  temporary drivers. `enter` stops the child's rpc process and switches the
  main REPL onto the agent's session file via `ctx.switchSession` — your
  skin, your editor, every command. `d` on an **Attached** row respawns
  background supervision on the same session file and switches you back.
  The fleet survives session switches (`session_shutdown` now only tears
  down on quit/reload); takeover/detach require the command context, so
  they work via `/agent-panel`, not `alt+p`. `space` keeps the in-panel
  quick look (native message components).

## Unreleased fixes (2026-09-08, post-0.2.0)

- **Silent notifications (user feedback: "duplicate notification cards")**:
  pty capture proved the render layer shows each card exactly once (883/883
  frames); the perceived duplication came from `triggerTurn: true` — the
  main session launched a real model round reacting to every notification
  (observed running `bash` on its own initiative). Notifications are now
  injected with `triggerTurn: false` (pure transcript append in both idle
  and streaming host states), matching CC's task-notification behavior.

- **Native conversation view (user feedback: "jump in like CC's normal
  session screen")**: the panel's view mode no longer renders hand-rolled
  transcript text. A new `ConversationView` replays the mirrored rpc event
  stream into pi's own message components (`UserMessageComponent`,
  `AssistantMessageComponent`, `ToolExecutionComponent`) — the same markdown
  bubbles and tool cards the main REPL renders. Supervisor gained
  `tailEvents` (raw event bootstrap, capped at 400 with a truncation hint)
  and `onChildEvent` (live growth tap). Tool cards use the component
  fallback style because pi's exports map blocks its built-in renderers.

- **Interaction revisions (user feedback)**: list mode supports type-to-talk
  (any printable non-command key opens the new-task composer — no `n`
  needed); submitting a new task stays in the list with the fresh agent
  selected instead of auto-jumping into its view; in view mode, `←` returns
  to the list even while the composer is focused, as long as the draft is
  empty (a non-empty draft still moves the cursor, so drafts are never lost
  to an accidental arrow).

- **Keyboard input under the Kitty keyboard protocol**: terminals with Kitty
  protocol active (Ghostty/kitty/iTerm2 and friends) encode plain keys as
  CSI-u sequences, so the panel's bare-character comparisons (`n`, `x`, `X`,
  `space`, `j/k`, `R`, `q`) never matched — the panel opened but no key
  reached it. All routing now goes through `matchesKey` (dual legacy + Kitty
  matching), key-release events are filtered, and type-to-talk accepts both
  decodable Kitty sequences and legacy printable bytes (incl. IME-committed
  CJK text, which arrives as raw UTF-8 either way).
- List mode now pads to the full terminal height (the overlay is as tall as
  the component's output; short rosters previously left the host UI visible).
- StatusPill yields when `claude-code-tui` appears in the settings packages
  list (the git-installed fork carries no tool sourceInfo).

## 0.2.0 (2026-09-08)

Complete architecture pivot to long-lived rpc children (proposal-v2 r3): the
v0.1 floating inspector becomes a fullscreen panel where jumping into an agent
is a real conversation.

### Changed

- **Children are long-lived `pi --mode rpc` processes** driven through the host
  package's `RpcClient` (no version drift: the host package *is* the running
  pi). v0.1's one-shot `--mode json -p` pipeline is gone.
- **FleetSupervisor rewritten as a session pool** behind a `RpcSessionFactory`
  seam: `spawn/prompt/steer(auto)/abort/archive/pin/list/tail/onEvent/dispose`.
  States: `starting → working ⇄ awaiting-input`, `crashed`, `archived`.
  Event-first state derivation (`agent_start`/`agent_end`, `willRetry` aware);
  one `getState()` alignment after spawn; a slow liveness probe (5s) only
  detects idle-time death.
- **FleetPanel rewritten**: fullscreen overlay (100%/margin 0), groups
  Pinned/Working/Awaiting input/Archived with three-segment counts, and a
  view mode with a resident pi-tui `Editor` composer — CJK/paste/cursor for
  free; submit is `prompt()` when idle, native `steer` while working;
  `←`/`esc` back; crashed/archived agents disable the composer with a hint.
- **NotificationBridge**: trigger moved from process-exit to turn-end, with
  the suppression matrix (panel-origin turns and currently-viewed agents stay
  silent; background turns notify at-most-once, quota-capped). Crashes notify
  unless viewed; archives never notify. Notifications include the session file.
- **Keys**: `x` = abort current turn (agent survives); `X`/`ctrl+x` = archive
  (kill + hide, JSONL kept, persisted to `state.json`); `n` = new-task
  composer; `p` = pin; `space` = jump in + focus composer; type-to-talk in
  view mode.
- Live-agent limit tightened 8 → **4** (each child is a resident pi process).
- Child isolation: `--no-extensions --no-skills` + `PI_AGENT_PANEL_CHILD=1`;
  waiting-type `extension_ui_request` dialogs are actively cancelled and
  surfaced as `⚠ child ui request denied` lines.
- Orphan self-heal verified end-to-end: rpc children exit on stdin EOF — no
  leftover processes when the host dies.
- StatusPill now shows `N working · M awaiting` and refreshes on child
  activity, not only main-session tool results.

### Removed

- `child-steer-runtime.ts` and the v0.1 file-inbox steer scaffolding (never
  shipped; rpc's native steer replaces it).
- `/agent-panel stop` remains as an alias of `archive`.

### Tests

- Unit: fake rpc sessions (scripted event replay) — 39 tests covering the
  session-pool state machine, suppression matrix, archive persistence and the
  panel list⇄view/composer flow with a real embedded Editor.
- Contract: unchanged (json event-stream pins; rpc events are the same family).
- Integration (real rpc children): two-turn conversation on the same child,
  mid-run abort with agent survival, archive leaves no matching process,
  stdin-EOF orphan self-heal.

## 0.1.0 (2026-09-07)

Initial release: one-shot `pi --mode json` children, near-fullscreen inspector
overlay, terminal-state notifications, status pill. (Form factor superseded
by 0.2.0.)
