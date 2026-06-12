# Installing DECX for OpenCode

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed

## Installation

Add DECX to the `plugin` array in your `opencode.json` (global or project-level):

```json
{
  "plugin": ["decx@git+https://github.com/jygzyc/decx.git"]
}
```

Restart OpenCode. The plugin installs from git and adds DECX `skills/` to OpenCode's skill search path.

Verify with OpenCode's native `skill` tool:

```text
use skill tool to list skills
use skill tool to load decx-cli
```

## Migrating From Old Manual Install

If you previously installed DECX for OpenCode using manual plugin files or symlinks, remove the old setup:

```bash
# Remove old manual plugin files
rm -f ~/.config/opencode/plugins/decx.js

# Remove old manual skills path
rm -rf ~/.config/opencode/skills/decx

# Optionally remove the cloned repo
rm -rf ~/.config/opencode/decx
```

Remove any DECX-specific `skills.paths` entry from `opencode.json` if you added one manually.

Then follow the installation steps above.

## Usage

Use OpenCode's native `skill` tool:

```text
use skill tool to list skills
use skill tool to load decx-cli
use skill tool to load decx-app-vulnhunt
```

### Available Skills

| Skill | Description |
|---|---|
| `decx-cli` | DECX CLI usage, session management, code inspection, and Android metadata commands. Routes to specialized skills as needed. |
| `decx-app-vulnhunt` | APK app-layer vulnerability hunting with the SQLite blackboard workflow for Facts, Intents, Events, links, and composed exploit chains. |
| `decx-framework-vulnhunt` | Framework and Binder-service vulnerability hunting with caller identity, authorization, privileged sink, and composition evidence gates. |
| `decx-poc` | Builds PoC or verification artifacts from finalized DECX analysis graph paths or selected findings. |
| `decx-report` | Generates reports from finalized DECX analysis artifacts. |

Start with `decx-cli` for general DECX work. It handles CLI navigation and routes to `decx-app-vulnhunt`, `decx-framework-vulnhunt`, `decx-poc`, or `decx-report` as needed.

## Updating

DECX updates automatically when you restart OpenCode.

To pin a specific version:

```json
{
  "plugin": ["decx@git+https://github.com/jygzyc/decx.git#<tag-or-branch>"]
}
```

## Troubleshooting

### Plugin not loading

1. Check logs: `opencode run --print-logs "hello" 2>&1 | grep -i decx`
2. Verify the plugin line in your `opencode.json`
3. Make sure you are running a recent OpenCode version

### Skills not found

1. Use the `skill` tool to list discovered skills
2. Check that the plugin is loading (see above)
3. Restart OpenCode after changing `opencode.json`

### Tool mapping

When skills reference Claude Code tools:
- `TodoWrite` → `todowrite`
- `Task` with subagents → `@mention` syntax
- `Skill` tool → OpenCode's native `skill` tool
- File operations → your native tools

## Getting Help

- Report issues: https://github.com/jygzyc/decx/issues
