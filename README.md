# Paseo Team Manager

Paseo Team Manager is a Paseo plugin (`>=0.17.1`) that equips top-level project conversations with a configurable Commander role and a reusable team roster. It supports Paseo desktop, web, iOS, and Android clients, including light and dark themes and English and Simplified Chinese interfaces.

## Features

- **Automatic Commander instructions**: New top-level sessions receive structured project coordination instructions, workspace context, active member presets, and ready-to-copy `create_agent` parameters.
- **Direct-edit boundary**: The default Commander policy forbids direct changes to project business source files. The Commander researches, plans, delegates, reviews diffs, validates tests, and reports results.
- **Live roster and sync plans**: `team_get_roster` shows the active preset, current model assignments, and drift for the Commander's own live role sessions.
- **Native Paseo collaboration**: The Commander uses Paseo's native `create_agent` and `send_agent_prompt` tools, with `notifyOnFinish` to preserve completion wakeups and the native Subagents track.
- **Role isolation and configuration fallback**: Role labels and metadata receive member-specific defaults for model, mode, thinking level, and provider options. Child sessions receive only their role instructions and do not receive Commander instructions.
- **Cross-platform controls**: A sidebar entry, settings screen, live host provider and model catalog, Composer team selector, `/team` shortcuts, and a `⌘K` Command Center entry provide configuration and status access.
- **Workspace policy**: Global settings, workspace or directory overrides, per-session metadata, and excluded directories determine whether team coordination applies.

## Default team

The default full-stack preset includes two active members and three optional members.

| Role | Provider and model | Thinking | Mode |
| --- | --- | --- | --- |
| Backend | `auto` host-adaptive | host-adaptive | Inherited |
| Frontend | `auto` host-adaptive | host-adaptive | Inherited |
| Reviewer | `auto` host-adaptive | host-adaptive | Inherited |
| QA | `auto` host-adaptive | host-adaptive | Inherited |
| Explorer | `auto` host-adaptive | host-adaptive | Inherited |

The default preset stores `provider: "auto"` and resolves each role against the host's ready Provider catalog. On a typical Magpie-enabled host, backend and QA resolve to Codex `auto/gpt-6.2-sol` with `xhigh`, frontend resolves to Antigravity `gemini-4-neon`, and explorer resolves to Antigravity `gemini-4-hydrogen`. Native Codex, Claude Code, Antigravity-only, and other ready providers receive supported fallbacks. Optional roles start disabled and can be enabled in the team settings.

Auto-match and cross-provider fallback leave the session permission mode unset so the session inherits Paseo's defaults. The plugin applies a preset permission mode only when you explicitly select it for the provider that will run the agent.

The global team switch is a hard gate. When it is disabled, session metadata and workspace overrides cannot enable team behavior. Creation defaults apply only when team mode is enabled for the current directory or workspace and the new agent explicitly carries the team role metadata.

## Changing models in an existing Commander session

Ask a Commander to change a member's model, for example “Switch backend to `codex/auto/gpt-6.2-sol`.” The Commander uses `team_update_member_model` to save an override for that session. Ask to reset one role or restore all member defaults to clear the corresponding overrides.

Starting in v0.3.1, editing a role's model configuration or restoring its defaults in Settings supersedes a session override saved against a different configuration. Overrides from v0.3.0 stay active until reset or rewritten. On the next task, an existing Commander reads the latest roster before dispatching. When a Commander opens or resumes, its instructions also include any detected sync plans for its existing subagents. Paseo 0.17.1's reload API can interrupt a turn, so active sessions get freshness through the live roster.

The Commander checks the live roster before assigning work. For the same provider, it uses native `update_agent` to apply changes to the model, thinking level, or supported options while preserving the subagent's context. If the provider changes and the Commander has no reusable session on the target provider, it creates a replacement, hands off a context summary, and keeps the original session available. Archiving requires an explicit user request.

Model updates preserve existing session permission modes. A new agent can inherit an explicitly configured preset mode when the override keeps that preset's provider. Auto and cross-provider overrides and replacement plans leave the new session's mode to Paseo. If Paseo requires an explicit mode to create the replacement, the user chooses it for the target provider.

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
