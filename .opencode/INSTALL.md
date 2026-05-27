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

Restart OpenCode. The plugin installs from git, registers DECX skills, and exposes the lightweight DECX workflow tools.

Verify with OpenCode's native `skill` tool:

```text
use skill tool to list skills
use skill tool to load decxcli
```

Verify the workflow tools are available:

```text
use decx_analyze with dryRun=true and target="sample.apk"
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
use skill tool to load decxcli
use skill tool to load decxcli-app-vulnhunt
```

Start with `decxcli` for DECX-related work. It handles general DECX CLI navigation and routes to `decxcli-app-vulnhunt`, `decxcli-framework-vulnhunt`, `decxcli-poc`, or `decx-subagent-analysis`.

For automated analysis, prefer the Python-backed exploration tools:

- `decx_analyze`: creates `.decx-analysis/<target>/run.json` as a Fact / Intent / Hint board and runs `bootstrap`, `explore`, and `reason` steps
- `decx_status`: reads a workflow run state
- `decx_resume`: resumes a previous workflow run state
- `decx_hint`: appends human guidance to the board without pretending it is a fact

The OpenCode plugin is a thin JavaScript shim. The core engine is Python under `decx-agent/decx_agent/`.

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
