# pi-agent-panel

Actionable multi-agent fleet panel for the [pi coding agent](https://pi.dev): spawn, watch, interrupt and stop headless child pi sessions from a single TUI overlay — the Claude Code agent-panel experience without leaving pi's single terminal.

- **FleetSupervisor** (deep module): owns the full child lifecycle — headless spawn (`pi --mode json -p`), JSONL event parsing, state aggregation, terminal-state detection. Zero TUI code; process creation goes through an injected seam (fake-runner unit tests, real-CLI contract/integration tests).
- **FleetPanel** (overlay): near-fullscreen double pane — left roster (status · name · tokens · preview), right transcript tail. `jk` select · `enter` follow · `PgUp/PgDn` scroll · `i` interrupt · `x x` confirm-stop · `r` refresh · `Esc` close.
- **NotificationBridge**: when a child reaches a terminal state, a structured notification is injected back into the main session (`followUp` + `triggerTurn`), at-most-once per child, quota-capped.
- **StatusPill**: a one-line widget with the live-agent count; auto-yields when pi-claude-code-tui is detected (config override below).

Memory invariant: *disk is the full set, live is a suffix.* Per child, only scalar aggregates stay resident; every stdout line is mirrored to `events.jsonl` and full history lives in the child's own `--session` JSONL. Panels re-read the tail from disk on demand.

## Install / develop

```bash
pnpm install
pnpm test              # unit (fake runner, no processes)
pnpm test:contract     # pins the real `pi --mode json` stream shape (real CLI)
pnpm test:integration  # supervisor vs real headless children (network/model)
pnpm typecheck
```

Run inside pi without installing:

```bash
pi -e ./path/to/pi-agent-panel/extensions
```

## Usage

```
/agent-panel spawn <name> <prompt...>   # spawn a headless child (cwd = current)
/agent-panel stop <name|id>             # stop a live child
/agent-panel                            # open the fleet overlay (or alt+p)
```

Manual verification sequence (interactive pi):

1. `pi -e ./extensions` (or with your usual setup) → `/agent-panel spawn demo Reply with exactly: pong`
2. `alt+p` opens the panel; the roster shows `● demo` and tokens tick up in the transcript pane.
3. `j`/`k` to select, `enter` to auto-follow the transcript, `PgUp/PgDn` to scroll back.
4. For a long task (`/agent-panel spawn slow Count slowly from 1 to 1000, one number per line.`), press `x` once (footer shows `x! confirm-stop`), `x` again to stop → state flips to `■ stopped`.
5. `Esc` closes the panel; shortly after a child finishes, the main session receives an `agent-panel` notification (the model is woken by `triggerTurn`).
6. Child artifacts live under `~/.pi/agent/agent-panel/<id>/`: `session.jsonl` (child's full session), `events.jsonl` (raw event mirror), `stderr.log` (failure post-mortem).

## Configuration

`~/.pi/agent/agent-panel/config.json`:

```json
{ "pill": "auto" }   // "auto" (default: hide when pi-claude-code-tui is present) | "on" | "off"
```

Override the child pi binary for testing: env `PI_AGENT_PANEL_PI_BINARY`.

## Design & scope (v1)

See [docs/research.md](docs/research.md) (verified Phase-1 research) and [docs/design.md](docs/design.md) (Decision Register D1–D7). v1 ships spawn / list / interrupt / stop / transcript / notifications / pill; **steer** is a seam placeholder returning `"not-implemented"` until phase 2 (file-inbox + child-side runtime extension, mirroring pi-subagents' proven protocol).

Known limitations (documented, not hidden):

- `--permission-mode` is an *extension-registered* flag, not builtin — children spawned with `--no-extensions` reject it. v1 forwards it only when explicitly set via the spawn API; default children run under pi's headless default permissions.
- The overlay uses `ctx.ui.custom` overlay mode (officially marked Experimental).
- Multi-widget coexistence with other extensions' widgets is best-effort; use the `pill` config if visuals collide.

## License

MIT
