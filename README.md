# pi-agent-panel

Actionable multi-agent fleet panel for the [pi coding agent](https://pi.dev): run background pi agent sessions, jump into any of them and keep talking like a normal conversation — the Claude Code agent-panel experience inside pi's single terminal.

- **FleetSupervisor** (deep module): a pool of long-lived `pi --mode rpc` children driven through the host package's `RpcClient`. Full lifecycle — spawn, prompt/steer, abort, archive, state aggregation, turn-end events. Zero TUI code; session creation goes through an injected `RpcSessionFactory` seam (fake-session unit tests, real-CLI contract/integration tests).
- **FleetPanel** (fullscreen overlay): `N working · M awaiting input · K archived` roster with `Pinned/Working/Awaiting input/Archived` groups, and a **view mode** where jumping into an agent renders the real conversation with pi's own message components (`UserMessageComponent` / `AssistantMessageComponent` / `ToolExecutionComponent` — same markdown bubbles and tool cards as the main REPL, replayed from the mirrored event stream with live growth). A resident composer (pi-tui `Editor`: CJK, paste, cursor movement) submits `prompt()` when idle and native `steer` while the agent is working. `←`/`esc` returns to the list.
- **NotificationBridge**: when a *background* turn finishes, a structured notification card is injected into the main session transcript (display-only — it never drives a main-session model turn). Turns you started in the panel and agents you're currently viewing stay silent; at-most-once per turn, quota-capped, crashes always reported.
- **StatusPill**: one-line widget with live counts; auto-yields when pi-claude-code-tui is detected (config override below).

Memory invariant: *disk is the full set, live is a suffix.* Per child, only scalar aggregates stay resident; every rpc event is mirrored to `events.jsonl` and full history lives in the child's own `--session` JSONL. Panels re-read the tail from disk on demand.

## Install / develop

```bash
pnpm install
pnpm test              # unit (fake rpc sessions, no processes)
pnpm test:contract     # pins the real `pi --mode json` stream shape (real CLI)
pnpm test:integration  # supervisor vs real rpc children (network/model)
pnpm typecheck
```

Run inside pi without installing:

```bash
pi -e ./path/to/pi-agent-panel/extensions
```

## Usage

```
/agent-panel spawn <name> <prompt...>   # start a background task (long-lived rpc child)
/agent-panel archive <name|id>          # archive: kill + hide, session JSONL kept
/agent-panel stop <name|id>             # alias of archive (v0.1 compat)
/agent-panel                            # open the fullscreen panel (or alt+p / shift+left)
```

> **←** opens the panel when the input is empty — CC's exact "← for
> agents", including right after a takeover, from inside the attached
> agent's own session. With a non-empty draft, `←`/`→` stay hands-off and
> `ctrl+b`/`ctrl+f` remain the cursor moves. **Shift+Left** opens the panel
> regardless of the draft. **→** (empty input) returns to your own
> conversation when the main REPL is inside an attached agent's session —
> the mirror of ←. Takeover/detach picked from a shortcut-opened panel work
> too: they are dispatched as their `/agent-panel takeover|detach` command,
> which runs with a fresh command context (the dispatched message itself is
> never persisted nor sent to the model).
>
> These bindings override pi's built-in editor cursor keys, so pi shows an
> informational `[Extension issues]` banner unless those keys are removed
> from the built-in bindings. Recommended in `~/.pi/agent/keybindings.json`:
> `{"tui.editor.cursorLeft": ["ctrl+b"], "tui.editor.cursorRight": ["ctrl+f"]}`
> — no banner; word moves on alt/ctrl+arrow are untouched.

### Keys

| Key | List mode | View mode |
|---|---|---|
| `j/k` `↑/↓` | move selection | scroll transcript line by line |
| `enter` | **takeover**: the main REPL adopts the agent's session (a real, full-skin pi) — `/agent-panel` only | focus composer |
| `space` | quick look: open the in-panel conversation view | focus composer |
| `d` | detach an attached agent: respawn background supervision, main REPL switches back | — |
| type any character | starts a new-task composer (type-to-talk) | starts composing (type-to-talk) |
| `n` | new-task composer (same as typing directly) | — |
| `x` | abort current turn of selected agent (rpc abort, agent stays alive) | abort current turn |
| `X` / `ctrl+x` | archive selected (kill + hide; `pi --session <file>` can reopen) | — |
| `p` | pin/unpin | — |
| `PgUp/PgDn` | — | page transcript (stops auto-follow) |
| `←` / `esc` | (esc) close panel | back to list (`←` works even with the composer focused while the draft is empty) |
| composer `enter` / `esc` | submit / cancel draft | submit (working → steer) / cancel draft |

The panel composer is a real pi-tui `Editor`: CJK/IME input, multi-line, terminal paste, cursor/kill/yank all work. While the agent is working, the same submit is delivered as a native steering message — one input box, correct semantics in both phases.

### Manual verification sequence (interactive pi)

1. `pi -e ./extensions` → `/agent-panel` (or `alt+p`) — the panel covers the whole terminal, header shows `0 working · 0 awaiting input · 0 archived`.
2. Just start typing a Chinese task (e.g. `用一句话解释缓存失效`) — the new-task composer opens directly — then press `enter`. The agent spawns, the list stays put with the new agent selected (`started '…' — enter to open`).
3. Press `space` on the selected agent for the in-panel quick look — pi's native message components (markdown bubbles, tool cards), grown live as events arrive. When the turn ends the header flips to `awaiting-input`; press `←` (empty composer) to return to the list.
4. Press `enter` instead to **take over**: the panel closes, the child's rpc process stops, and the main REPL resumes the agent's session file — a complete pi with your skin, editor, and every command. The agent shows up under **Attached** in the panel; open `/agent-panel` and press `d` on it to detach (background supervision resumes on the same session file, and you switch back to your own session). Takeover/detach need the command context, so they work via `/agent-panel`, not `alt+p`.
4. Type a follow-up question in the composer and press `enter` — a **second turn on the same child** (real conversation, context preserved).
5. Press `←` to return to the list. Start a long task (`n` → `用 bash 执行 sleep 60 并等待`), jump in, press `x` — the turn aborts, the agent survives, you can keep asking.
6. Press `X` on an agent — it moves to `Archived`, the process is gone, and `~/.pi/agent/agent-panel/<id>/session.jsonl` remains (`pi --session <file>` reopens it).
7. Close pi (`esc`/`ctrl+d`). `pgrep -f agent-panel` shows no leftover children — rpc children self-terminate on stdin EOF.

Child artifacts live under `~/.pi/agent/agent-panel/<id>/`: `session.jsonl` (child's full session), `events.jsonl` (event mirror), `crash.log` (post-mortem). The archived set is tracked in `~/.pi/agent/agent-panel/state.json`.

## Configuration

`~/.pi/agent/agent-panel/config.json`:

```json
{ "pill": "auto" }   // "auto" (default: hide when pi-claude-code-tui is present) | "on" | "off"
```

- Env `PI_AGENT_PANEL_PI_BINARY`: override the pi CLI entry **script** used to spawn rpc children (must be a node-runnable script — RpcClient spawns `node <script>`; a PATH wrapper binary will not work).
- `alt+p` needs Option-as-Meta in some macOS terminal setups (iTerm2: "Option key sends Esc+"; Terminal.app: enable "Use Option as Meta key"). The `/agent-panel` command always works regardless.

## Design & scope

See [docs/proposal-v2.md](docs/proposal-v2.md) (v2 spec, r3) and [docs/design.md](docs/design.md) (Decision Register D1–D11; D1 revised for the rpc architecture, D5/D10 voided, D11 is the session-pool design). [docs/research.md](docs/research.md) holds the verified Phase-1 research.

Known limitations (documented, not hidden):

- Each agent is a full resident pi process (Node + agent runtime) — the pool limit defaults to **4** for that reason; archiving frees the slot. Memory-wise this is the deliberate trade of long-lived conversational agents.
- Children run with `--no-extensions --no-skills` and a clean env (`PI_AGENT_PANEL_CHILD=1`); any child-side UI dialog is actively denied and shown as `⚠ child ui request denied`. Permission bridging through `extension_ui_request` is phase 2.
- Cross-restart revive (`R` key placeholder in view mode) is phase 2: session files survive, but children are not respawned automatically.
- The main session's *temporarily switched* model is forwarded once at spawn (`provider/id`); model-switching inside a child afterwards belongs to the child.
- The overlay uses `ctx.ui.custom` overlay mode (officially marked Experimental).
- Multi-widget coexistence with other extensions' widgets is best-effort; use the `pill` config if visuals collide.

## License

MIT
