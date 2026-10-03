<img src="resources/icon.png" width="128" alt="">

# Drover

**English** · [Русский](README.ru.md)

A desktop app for [herdr](https://herdr.dev) in the spirit of the Claude Code and Codex desktop apps: your agents live in herdr, and you talk to them in a proper chat — with pasted screenshots, history, statuses and usage limits. No terminal required, but it is always one keystroke away.

*Drover* — someone who drives a herd to where it needs to go. herdr keeps the herd of agents; Drover drives it toward the task. The icon is a D with three agents inside.

## Features

- **Chat instead of a terminal.** Claude Code and Codex conversations are rendered from their own session files: markdown, highlighted code, grouped tool calls ("Ran 5 commands, edited 2 files"), edit diffs, plans/todos, "Worked for 2m 31s".
- **Screenshots.** ⌘V in the composer, drag and drop, or the paperclip. Images are saved to `~/.drover/attachments/` and handed to the agent as attachments (`[Image #1]` in Claude Code and Codex). HEIC/TIFF photos are converted to JPEG automatically.
- **All herdr agents.** Sidebar: projects (workspaces) → tabs → agents with *Working / Needs input / Done* statuses. "Needs attention first" sorting, ⌘K search.
- **New agent** (⌘N): project or folder; Claude Code, Codex, any agent herdr supports, or a plain terminal; new tab or split; a separate git worktree; launch arguments; a first message.
- **A model for every agent.** Pick the model and reasoning level when you start an agent (New agent, a team, or a role — `model:`/`effort:` in the role file), and switch them later from the chat: the model chip under the composer opens a menu. Drover switches through the agent's own `/model` menu with "this session only", so your defaults in Claude Code and Codex stay as they are. Codex's model list comes from its local cache.
- **Roles.** Pick a role in the New agent dialog (orchestrator, frontend, backend, reviewer, QA or your own) and the agent gets its instructions as the first message. Drover waits until the agent is actually ready for input and checks that the message was picked up; if the agent asks something on startup (folder trust, for example), the instructions go out as soon as you answer. Project roles come from `.ai/roles/*.md` or `.herdr/roles/*.md`; your own roles and tweaks live in Settings → Roles.
- **A whole team in one click** (right-click a project → Start team…): every agent opens in its own tab with its role; the orchestrator starts last and is told who is on the team and how to hand out work (`herdr agent prompt <name> …`).
- **Task board** per project (the "Tasks" row under a project in the sidebar). The orchestrator keeps the team's tasks in `.drover/tasks.json` — who does what, and whether it is waiting, in progress, in review, done or blocked — and Drover shows them as columns, next to what every agent is doing right now (its latest request and its own plan). Add tasks right on the board: they go to the orchestrator, which splits them up and hands them out in parallel. Drover keeps `.drover/` out of git through `.git/info/exclude`.
- **One orchestrator is enough** for any number of tasks: it gives each free agent its own task in parallel (`herdr agent prompt … --wait` running in the background) and reads the answers as they finish.
- **Message several agents** at once — one broadcast to the agents you pick.
- **Site preview** (⌘⇧P): a local site or HTML file opens on the right. It starts empty: open an HTML file (button, drag and drop, or a path in the address bar), one of the project's dev servers (detected automatically) or a recent page. Local pages that agents hand over open by themselves; links to the internet only show a notification with an Open button. Pick mode (⌘⇧C) highlights elements under the cursor; a click sends the element to the composer — with its selector, React component and source file (when available), HTML, styles and a screenshot of the element. Shift-click picks several. Viewport sizes: full / 1280 / 768 / 390.
- **Agents open the preview themselves:** `herdr pane report-metadata "$HERDR_PANE_ID" --source drover --token preview=<localhost URL or HTML path relative to the agent's folder>` (herdr keeps 80 characters of a token) — a hint about this is added to role instructions (can be turned off in Settings → Roles).
- **Skip permission prompts.** New agent and Start team have a "Skip permission prompts (bypass)" switch: Claude Code starts with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`. Use it only in projects you trust; the choice is remembered.
- **When an agent waits for you** (a permission or a question) — an amber banner with `1 2 3 ↑ ↓ Enter Esc` buttons and a live terminal below.
- **Terminal.** A ⌘J panel under the chat or full-screen (⌘⇧T) — the real terminal of the herdr pane (xterm.js, WebGL) with input, scrollback and image paste.
- **Usage limits** — from local files only, no tokens, no API requests. Codex: windows from its session files. Claude Code: the 5-hour and weekly windows via the Claude Code status line (turned on in Settings). A mini gauge in the sidebar, details on click, a chip in the composer.
- **macOS notifications** when an agent finishes or needs input, plus a Dock badge.
- **Managing herdr:** rename/close agents, tabs, panes and projects, splits, zoom, moving a pane to its own tab, herdr sessions, starting the server, installing integrations, plugins.
- **Languages:** English, Русский, Español, Deutsch, 中文 (Settings → General → Language; follows the system by default).

### Appearance (Settings → Appearance)

- 16 built-in themes: Light, Dark, Paper, Midnight, Dracula, Nord, Tokyo Night, Catppuccin Mocha/Latte, Rosé Pine, Gruvbox, One Dark, GitHub Light/Dark, Solarized Light/Dark — plus "System". Themes recolor the terminal too.
- **Your own theme:** "Customize this theme…" copies the current one; the editor changes 12 colors, the light/dark base and the name. Themes export to `.drover-theme.json` files and import back.
- **Accent** — 8 presets or any color.
- **Background:** 9 gradients, your own image (PNG, JPEG, WebP, GIF, HEIC…) or video (MP4, WebM, MOV), with dimming, blur and panel transparency ("glass"), fill or fit. The file is copied into the app's data.
- Interface and terminal fonts, chat and terminal font sizes, corner radius, density.

## Install

You need [herdr](https://herdr.dev) (`curl -fsSL https://herdr.dev/install.sh | sh`) and the agents you want to use (`claude`, `codex`, …). The app is built for macOS on Apple Silicon.

1. Download `Drover-<version>-arm64.dmg` from [Releases](https://github.com/mariotgb/drover/releases/latest) and drag Drover to Applications.
2. The app is not notarized by Apple, so macOS blocks the first launch. Open it once, then go to System Settings → Privacy & Security and click **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/Drover.app`).
3. Drover connects to the running herdr server or starts one itself — agents keep working after you close the app. To stop herdr together with Drover, turn on Settings → herdr → **Stop herdr when quitting Drover** (Drover asks first if agents are still working).

For accurate chats and statuses, install the herdr integrations (Settings → Integrations, or `herdr integration install claude` / `codex`).

### Usage limits

Drover never uses your tokens and never calls the Anthropic or OpenAI APIs — limits are read from disk only.

- **Codex** writes a snapshot of its limits into every session file (`~/.codex/sessions/…`); Drover takes the newest one.
- **Claude Code** receives the limits with every reply and officially passes them to the status-line command (`statusLine`). Settings → General → Claude Code limits → **Turn on** plugs a small local script, `~/.drover/claude-statusline.sh`, into `~/.claude/settings.json` (a copy of the file is kept next to it as `settings.json.drover-backup`). The script saves what Claude Code passes it to `~/.drover/claude-status/` and prints "5h 42% · wk 6%" in Claude's status line. If you already had a status line, it keeps working. **Turn off** puts everything back.

## Keyboard shortcuts

| | |
|---|---|
| ⌘N / ⌘⇧N | New agent / new project |
| ⌘T | New terminal tab |
| ⌘K | Search threads and commands |
| ⌘J | Terminal panel under the chat |
| ⌘⇧T | Chat ↔ terminal |
| ⌘⇧P | Site preview |
| ⌘⇧C | Pick an element in the preview |
| ⌘. | Stop the agent (Esc) |
| ⌘[ / ⌘] / ⌘1…9 | Switch threads |
| ⌘⇧] | Next agent that needs attention |
| ⌘B | Sidebar |

## Development

```bash
npm install
npm run dev        # run with hot reload
npm test           # parsers, limits, sending, agent creation and translations
npm run typecheck
npm run dist       # build the .app and .dmg into release/
```

The icon is an Icon Composer document, `resources/Drover.icon` (SVG layers + `icon.json`): macOS 26+ draws it as Liquid Glass and derives the dark, tinted and clear looks itself. `npm run icon` regenerates it from `scripts/make-icon.mjs`, and you can open and tweak it in Icon Composer. With Xcode 26+ set up (`sudo xcodebuild -runFirstLaunch`), `npm run dist` compiles the live Liquid Glass icon with `actool`; without it the build uses the pre-rendered `resources/icon.icns`.

Development variables: `DROVER_SESSION=<name>` — use another herdr session, `DROVER_USER_DATA=<dir>` — a separate profile, `DROVER_READONLY=1` — view only (no input, focus or resize; terminals in observe mode), `DROVER_BACKGROUND=1` — the window doesn't take focus (for automated tests).

### How it works

- `src/main/herdr/` — herdr socket API client (NDJSON over `~/.config/herdr/herdr.sock`), event subscriptions, snapshots, server auto-start.
- `src/main/terminal.ts` — every open terminal is a `herdr terminal session control <pane>` process: the server renders frames at our size, input/resize/scroll go in as JSON commands.
- `src/main/transcripts/` — finding and incrementally parsing Claude Code sessions (`~/.claude/projects/…/<id>.jsonl`) and Codex sessions (`~/.codex/sessions/…/rollout-…jsonl`). The session id comes from the herdr integrations; without it, sessions are matched by process start time and cwd.
- `src/main/actions.ts` — sending messages: each screenshot is pasted as a bracketed paste of its path, then the text goes through `agent.prompt`. Creating an agent: `agent.start`, waiting for `interactive_ready` via `agent.get`, then the first message with confirmation (`agent.prompt` + `wait`).
- `src/main/tasks.ts` — the task board: reads `.drover/tasks.json` leniently (comments, trailing commas, status synonyms), polls it, and edits it in place so the orchestrator's own fields survive.
- `src/main/models.ts` — the model catalog and switching a running agent's model: Drover reads the pane's screen, moves through the agent's `/model` menu and confirms with "use this session only" (Enter there would save a new default).
- `src/main/preview.ts` — dev server detection (`lsof` + process cwd) and element screenshots; `src/renderer/src/preview/` — the preview panel (`<webview>`) and the element picker script.
- `src/main/roles.ts`, `src/renderer/src/roles.ts` — project and built-in roles, team instructions.
- `src/shared/themes.ts`, `src/renderer/src/appearance.ts` — themes (the whole UI and terminal palette is derived from 12 colors) and backgrounds; background files are served over the `hdfile://` protocol with Range support for video.
- `src/renderer/src/i18n/` — translations (keys are the English strings), `src/main/i18n.ts` — menus and notifications.
- `src/main/limits.ts` — Claude Code and Codex limits.
- `src/renderer/` — the React UI.

The login-shell environment is resolved at startup, so the app launched from the Dock finds `herdr`, `claude` and `codex`, and a herdr server started by the app gets your usual `PATH`.

## Limitations

- The chat view is for Claude Code and Codex; other agents are shown as terminals.
- The preview detects the component and source file for React in dev mode; for other frameworks it sends the selector, HTML, styles and a screenshot.
- Panes of one tab are shown as separate threads, not as a grid; drag-and-drop sorting of tabs/projects isn't done yet.
- Remote herdr machines (`--remote`, `machine`) are not supported.

## License

[MIT](LICENSE)
