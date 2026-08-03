# Installing DECX for Codex

DECX skills are discovered by Codex through a symlinked `skills/` directory under `~/.agents/skills/decx`.

## Prerequisites

- Codex CLI
- Git
- `decx` CLI binary ([install guide](../../README.md))
- `node` 18+ (required by DECX report and PoC helper scripts)

## Installation

### macOS / Linux

```bash
git clone https://github.com/jygzyc/decx.git ~/.codex/decx
mkdir -p ~/.agents/skills
ln -s ~/.codex/decx/skills ~/.agents/skills/decx
```

Restart Codex to discover the skills.

### Windows (PowerShell)

```powershell
git clone https://github.com/jygzyc/decx.git "$HOME\.codex\decx"
New-Item -ItemType Directory -Force -Path "$HOME\.agents\skills" | Out-Null
New-Item -ItemType SymbolicLink -Path "$HOME\.agents\skills\decx" -Target "$HOME\.codex\decx\skills"
```

If symbolic links are blocked, use a junction:

```powershell
New-Item -ItemType Junction -Path "$HOME\.agents\skills\decx" -Target "$HOME\.codex\decx\skills"
```

Restart Codex to discover the skills.

## Available Skills

| Skill | Trigger | Requires |
|---|---|---|
| `decx-cli` | Run `decx` commands, open targets, inspect classes/methods/xrefs, manage sessions | `decx` |
| `decx-vulnhunt` | Audit APK app-layer or Android framework/Binder attack surfaces (App + Framework tracks) | `decx`, `node` |
| `decx-poc` | Build a PoC app from a finalized finding writeup | `decx`, `node` |
| `decx-report` | Generate HTML/Markdown reports from finalized finding writeups | `decx`, `node` |

## Usage

### Workflow

All DECX analysis starts through Codex's native skill system. Load a skill to activate its instructions.

```
use skill decx-cli
```

From `decx-cli`, specialized skills are loaded automatically when the task matches:

```
use skill decx-vulnhunt
use skill decx-poc
use skill decx-report
```

### Skill Workflow

The typical analysis flow:

1. **Navigate** — `decx-cli` to open a target and inspect code
2. **Hunt** — `decx-vulnhunt` to trace and prove exploitable paths (App or Framework track)
3. **Report** — `decx-report` to generate reports from finalized finding writeups
4. **PoC** — `decx-poc` to build an exploit app from one finalized finding writeup

### Analysis Output

Analysis notes and finding writeups live in the working directory.

## Updating

```bash
cd ~/.codex/decx && git pull
```

Skills update instantly through the symlink.

## Migrating from old bootstrap

If you installed DECX before native skill discovery:

1. Update the repo:

   ```bash
   cd ~/.codex/decx && git pull
   ```

2. Create the skills symlink using the installation steps above.
3. Remove any old DECX bootstrap block from `~/.codex/AGENTS.md`.
4. Restart Codex.

## Troubleshooting

### Skills not discovered

1. Verify the symlink exists:

   ```bash
   ls -la ~/.agents/skills/decx
   ```

2. Confirm `skills/` directory contains `SKILL.md` files:

   ```bash
   ls ~/.agents/skills/decx/*/SKILL.md
   ```

3. Restart Codex.

### `decx` command not found

1. Verify `decx` is on `PATH`:

   ```bash
   which decx
   ```

2. Install or update the CLI following the instructions in `README.md`.

### Permission errors on symlink (Windows)

Use a junction instead of a symbolic link (see installation steps).

## Uninstalling

### macOS / Linux

```bash
rm ~/.agents/skills/decx
rm -rf ~/.codex/decx
```

### Windows (PowerShell)

```powershell
Remove-Item "$HOME\.agents\skills\decx"
Remove-Item "$HOME\.codex\decx" -Recurse -Force
```
