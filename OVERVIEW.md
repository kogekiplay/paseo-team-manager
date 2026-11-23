Paseo Team Manager equips top-level Paseo sessions with team commander instructions, configurable role presets, and live team status controls so each project session automatically knows how to coordinate role-based subagents.

## How it works

When an agent session opens, Paseo Team Manager inspects its labels and metadata in the `agent.open.before` hook. History loads and background helper agents are skipped.

- Top-level sessions (agents without the `paseo.parent-agent-id` label) are evaluated as commanders according to priority: per-session metadata override, workspace or directory override, excluded directory rules, and finally the global settings. When active, the plugin appends structured commander instructions and attaches the read-only `team_get_roster` tool.
- Role subagents (agents carrying `paseo.parent-agent-id` plus a `paseo-team-manager.role` label or metadata role) receive only their role-specific instructions instead of commander instructions.

Commanders delegate work through Paseo's native `create_agent` and `send_agent_prompt` MCP tools rather than custom wrapper tools. This preserves Paseo's built-in Subagents track, `notifyOnFinish` completion wakeups, and message queueing. When `enforceMemberDefaultsOnCreate` is enabled, the `agent.create.before` hook also fills in any omitted model, session mode, thinking level, or provider options configured for that role.

## Setup and requirements

Requires Paseo 0.17.1 or later. Client controls and panels are built with cross-platform React Native primitives and work on desktop, web, iOS, and Android.

Open Team Manager from the sidebar header, open Settings > Plugins > Team Manager, or run `/team settings` in a workspace composer to review the default full-stack team preset, adjust roles using the live provider and model catalog from your host, or exclude casual directories such as `~/Downloads`.

The built-in full-stack preset includes two enabled core roles and three optional roles using Codex GPT routing groups and Antigravity Gemini 4 models:

- `backend` (enabled): `codex/auto/gpt-6.2-sol`, thinking `xhigh`, mode `full-access`, `service_tier: "default"`.
- `frontend` (enabled): `antigravity/gemini-4-neon`, thinking `high`, mode `full-access`.
- `reviewer` (optional): `codex/auto/gpt-6.2-astra`, thinking `xhigh`, mode `auto`, `service_tier: "default"`.
- `qa` (optional): `codex/auto/gpt-6.2-sol`, thinking `xhigh`, mode `full-access`, `service_tier: "default"`.
- `explorer` (optional): `antigravity/gemini-4-hydrogen`, thinking `medium`, mode `plan`.

## Capabilities and settings

- General toggles: enable or disable the plugin globally, control whether new top-level sessions auto-enable commander mode, show or hide the composer team selector, and automatically fill missing role defaults when subagents are created.
- Excluded directories: skip automatic commander mode in selected directories (supporting `~/...` and absolute paths), with a one-click shortcut for `~/Downloads`.
- Team presets: manage multiple team templates, choose a default preset, toggle the "commander must not edit source code directly" rule, and append custom commander instructions.
- Team members: enable or disable built-in roles, add or remove custom roles, and pick each role's provider, model, thinking level, session mode, and dynamic provider options (such as Codex `service_tier` or `plan_mode`) directly from the host catalog.
- Live commander prompt preview: inspect and copy the exact Markdown system prompt that will be appended to commanders.
- Composer, panel, and command controls: keep Paseo's native Subagents pill track untouched while switching team mode per session from the composer selector (`Auto`, `Off`, or a specific preset), opening the Team Status or Workspace Team panel from Command Center or `/team`, reloading an idle session to apply updated instructions immediately, or running `/team` (`status`, `on`, `off`, `auto`, `preset ID`, `settings`).

## Data handling and limits

The plugin does not make network requests to third-party services. Settings, host provider catalog lookups, and workspace agent queries stay local between the Paseo client and its connected daemon host.

When team mode is active for a session, the commander or role instructions appended by the plugin, along with workspace roster and subagent summaries returned when the commander calls `team_get_roster`, are sent to the session's configured agent provider as part of normal conversation context.

Changes to plugin settings or session metadata take effect when a session opens or reopens. Existing idle sessions are marked stale and reopen on the next prompt, or can be reopened immediately from the Team Status panel. Running turns are not interrupted automatically.
