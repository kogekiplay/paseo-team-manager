# Paseo Team Manager

Paseo Team Manager is a Paseo plugin (`>=0.17.1`) that equips top-level project conversations with a configurable Commander role and a reusable team roster. It supports Paseo desktop, web, iOS, and Android clients, including light and dark themes and English and Simplified Chinese interfaces.

## Features

- **Automatic Commander instructions**: New top-level sessions receive structured project coordination instructions, workspace context, active member presets, and ready-to-copy `create_agent` parameters.
- **Direct-edit boundary**: The default Commander policy forbids direct changes to project business source files. The Commander researches, plans, delegates, reviews diffs, validates tests, and reports results.
- **Read-only roster tool**: `team_get_roster` shows the active preset, complete member parameters, and live team subagents for the current workspace. It helps the Commander reuse healthy role sessions.
- **Native Paseo collaboration**: The Commander uses Paseo's native `create_agent` and `send_agent_prompt` tools, with `notifyOnFinish` to preserve completion wakeups and the native Subagents track.
- **Role isolation and configuration fallback**: Role labels and metadata receive member-specific defaults for model, mode, thinking level, and provider options. Child sessions receive only their role instructions and do not receive Commander instructions.
- **Cross-platform controls**: A sidebar entry, settings screen, live host provider and model catalog, Composer team selector, `/team` shortcuts, and a `⌘K` Command Center entry provide configuration and status access.
- **Workspace policy**: Global settings, workspace or directory overrides, per-session metadata, and excluded directories determine whether team coordination applies.

## Default team

The default full-stack preset includes two active members and three optional members.

| Role | Provider and model | Thinking | Mode |
| --- | --- | --- | --- |
| Backend | `codex/auto/gpt-6.2-sol` | `xhigh` | `full-access` |
| Frontend | `antigravity/gemini-4-neon` | `high` | `full-access` |
| Reviewer | `codex/auto/gpt-6.2-sol` | `xhigh` | `auto` |
| QA | `codex/auto/gpt-6.2-sol` | `xhigh` | `full-access` |
| Explorer | `antigravity/gemini-4-hydrogen` | `medium` | `plan` |

Codex members use the default `service_tier` provider option. Optional roles start disabled and can be enabled in the team settings.

The global team switch is a hard gate. When it is disabled, session metadata and workspace overrides cannot enable team behavior. Creation defaults apply only when team mode is enabled for the current directory or workspace and the new agent explicitly carries the team role metadata.

## Installation

Install the published GitHub source with:

```bash
paseo plugin add git:kogekiplay/paseo-team-manager
```

For local development, clone the repository and install the local plugin directory:

```bash
git clone https://github.com/kogekiplay/paseo-team-manager.git
paseo plugin install /absolute/path/to/paseo-team-manager
```

## Development

From the repository root, install development dependencies and run the checks:

```bash
npm install
npm run typecheck
npm test
```

The plugin uses Paseo-provided runtime libraries and does not require a build command or runtime dependency installation beyond the development dependencies used for typechecking and tests.

## License

Paseo Team Manager is released under the MIT License. See [LICENSE](LICENSE).
