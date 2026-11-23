Paseo Team Manager equips top-level Paseo sessions with team commander instructions, adaptive role presets, and live team status controls so each project session automatically knows how to coordinate role-based subagents.

## How it works

When an agent session opens, Paseo Team Manager inspects its labels and metadata in the `agent.open.before` hook. History loads and background helper agents are skipped.

- Top-level sessions (agents without the `paseo.parent-agent-id` label) are evaluated as commanders according to priority: the global `enabled` toggle acts as the top-level master switch (when off, commander prompt and `team_get_roster` injection stop across all sessions and workspaces, even if a session or workspace override exists), followed by per-session metadata override, workspace or directory override, excluded directory rules, and finally the auto-apply global default. When active, the plugin appends structured commander instructions and attaches the read-only `team_get_roster` tool.
- Role subagents (agents carrying `paseo.parent-agent-id` plus a `paseo-team-manager.role` label or metadata role) receive only their role-specific instructions instead of commander instructions.

Commanders delegate work through Paseo's native `create_agent` and `send_agent_prompt` MCP tools rather than custom wrapper tools. This preserves Paseo's built-in Subagents track, `notifyOnFinish` completion wakeups, and message queueing. When `enforceMemberDefaultsOnCreate` is enabled and team mode is active for that scope, the `agent.create.before` hook fills in omitted model, session mode, thinking level, or provider options only for sessions that explicitly declare a role via `paseo-team-manager.role` metadata, leaving ordinary unassigned sessions and their permission modes unchanged.

### Zero-config host auto-matching

All roles in the built-in full-stack preset (`backend`, `frontend`, `reviewer`, `qa`, `explorer`) default to `provider: "auto"`. At runtime, the plugin inspects the live catalog of enabled and ready providers on the connected host and picks a real available model, thinking level, and host-supported provider options for each role.

- Works across Magpie routing groups, native Codex, Claude Code, Antigravity, and other custom providers configured on your host.
- Automatically avoids high-cost models such as `astra` and `fable` during auto-matching and appends `service_tier: "default"` only when the host provider actually exposes that control.
- Session permission mode (`modeId`) stays unset during auto-matching and cross-provider fallback, inheriting the host default permissions. A permission mode is only sent when you explicitly pick one for a specific provider.
- If a locked provider or model is unavailable on a different machine, the runtime falls back to an available host model (or the caller's provider) without overwriting your saved preset, and offers a one-click Apply fallback action in settings.

## Setup and requirements

Requires Paseo 0.17.1 or later. Client controls and panels are built with cross-platform React Native primitives and work on desktop, web, iOS, and Android.

Open Team Manager from the sidebar header, open Settings > Plugins > Team Manager, or run `/team settings` in a workspace composer. All changes save automatically. You can keep roles on Auto-match for portable multi-machine setups, lock all roles to your current host's recommended models with one click, or customize any role individually.

## Capabilities and settings

- General toggles: enable or disable the plugin globally, control whether new top-level sessions auto-enable commander mode, show or hide the composer team selector, and automatically fill missing role defaults when role subagents are created.
- Excluded directories: skip automatic commander mode in selected directories (supporting `~/...` and absolute paths), with a one-click shortcut for `~/Downloads`.
- Team presets: manage multiple team templates, choose a default preset, toggle the "commander must not edit source code directly" rule, and append custom commander instructions.
- Team members and host auto-matching: enable or disable built-in roles, add or remove custom roles, choose `Auto-match host (Recommended)` or lock a specific provider, model, thinking level, session mode, and dynamic provider options from the live host catalog, lock all auto/fallback roles to host defaults, or reset all roles to Auto.
- Live commander prompt preview: inspect and copy the exact Markdown system prompt (using resolved host models) that will be appended to commanders.
- Composer, panel, and command controls: keep Paseo's native Subagents pill track untouched while switching team mode per session from the composer selector (`Auto`, `Off`, or a specific preset), opening the Team Status or Workspace Team panel from Command Center or `/team`, checking each role's resolved model or fallback badge, reloading an idle session to apply updated instructions immediately, or running `/team` (`status`, `on`, `off`, `auto`, `preset ID`, `settings`).

## Data handling and limits

The plugin does not make network requests to third-party services. Settings, host provider catalog lookups, and workspace agent queries stay local between the Paseo client and its connected daemon host.

When team mode is active for a session, the commander or role instructions appended by the plugin, along with workspace roster and subagent summaries returned when the commander calls `team_get_roster`, are sent to the session's configured agent provider as part of normal conversation context.

Changes to plugin settings or session metadata take effect when a session opens or reopens. Existing idle sessions are marked stale and reopen on the next prompt, or can be reopened immediately from the Team Status panel. Running turns are not interrupted automatically.
