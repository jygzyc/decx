# decx-cli

DECX CLI - Decompiler + X command-line tool.

## Install

```bash
npm install -g @jygzyc/decx-cli
```

## Usage

```bash
decx <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `decx process` | Manage DECX server processes |
| `decx self` | Install and update decx-server.jar |
| `decx android` | Android specific analysis |
| `decx code` | Common code analysis |

### process

```bash
decx process check               # Check environment status
decx process open <file> [options] # Open and analyze a file (APK, DEX, JAR, etc.)
decx process close [name] [--port <port>] [--all]  # Stop session
decx process list                  # List running sessions
decx process status [name]         # Check server status
```

### self

```bash
decx self install [-p]          # Install decx-server.jar (-p for prerelease)
decx self skills install [-c codex] # Install skills; defaults to ~/.agents/skills
decx self update [-p]           # Update decx-server.jar and the currently installed npm CLI package
```

**open options:**

| Option | Description |
|--------|-------------|
| `--port <port>` | Server port (omit to auto-assign a free random port in 30000–40000) |
| `--force` | Force start even if session exists |
| `-n, --name <name>` | Custom session name |
| `--mcp` | Also start the MCP Streamable HTTP server on port + 1 |

All standard [jadx-cli options](https://github.com/skylot/jadx) are passed through directly, including JADX `-P<key>=<value>` project properties. `decx process open` enables `--show-bad-code` by default, and common passthrough options also include `--deobf`, `--no-res`, `-j`/`--threads-count`, `--no-imports`, `--no-debug-info`, `--escape-unicode`, `--log-level`.

> **`-P` is not a port shortcut.** DECX uses `--port` everywhere for the server port, reserving `-P` for JADX `-P<key>=<value>` project properties (forwarded by `process open`). The properties DECX itself needs, such as `-Pdex-input.verify-checksum=no`, are injected automatically.

### android

```bash
decx android manifest                    # Get AndroidManifest.xml
decx android launcher-activity            # Get launcher activity name
decx android application                 # Get Application class name
decx android exported-components [--type <pattern>] [--no-regex] # List exported components
decx android deep-links                   # List deep link schemes
decx android dynamic-receivers [--limit <n>] [--include-package <pattern>] [--exclude-package <pattern>] [--no-regex] # List dynamic broadcast receivers
decx android framework-service-implementation <interface> # Find system service implementations
decx android device system-services [--serial <serial>] [--adb-path <path>] [--grep <kw>] # List Android system services as structured JSON
decx android device permission-info <permission> [--serial <serial>] [--adb-path <path>]        # Show structured permission details
decx android resources [--include <pattern>] [--no-regex] # List resource file names
decx android resource-file <res>             # Get resource file content
decx android strings                         # Get strings.xml content
decx android aidl-interfaces [--limit <n>] [--include-package <pattern>] [--exclude-package <pattern>] [--no-regex] # Get AIDL interfaces
decx android framework collect               # Collect framework files from the connected device
decx android framework process [oem]         # Process local framework sources; OEM can be inferred
decx android framework run                   # Collect, process, pack, and optionally open
decx android framework open [jar]            # Open the generated framework jar or a provided JAR
```

**ADB-backed command output**

`system-services` returns structured JSON:

```json
{
  "total": 2,
  "services": [
    {
      "index": 6,
      "name": "activity",
      "interfaces": ["android.app.IActivityManager"]
    },
    {
      "index": 511,
      "name": "window",
      "interfaces": ["android.view.IWindowManager"]
    }
  ]
}
```

`permission-info` returns one parsed permission object instead of raw shell text:

```json
{
  "permission": "android.permission.DUMP",
  "package": "android",
  "label": null,
  "description": null,
  "protectionLevel": "signature|privileged|development"
}
```

Examples:

```bash
decx android device system-services --serial emulator-5554
decx android device system-services --serial emulator-5554 --grep permission
decx android device permission-info android.permission.DUMP --serial emulator-5554
```

### android framework

`decx android framework` integrates the archived preprocessor workflow into the native CLI.
It supports both end-to-end collection from a connected Android device and offline
processing of an existing local framework dump.

Framework artifacts are not treated as a separate runtime session type.
Only `framework open` and `framework run` start a DECX server, and once opened they
are managed exactly like any other DECX session through `decx process list`,
`decx process status`, and `decx process close`.

```bash
decx android framework run
decx android framework run --no-open
decx android framework collect --serial emulator-5554
decx android framework process google --out-dir ~/.decx/output/framework/google
decx android framework open
decx android framework open ~/.decx/output/framework/google/framework_google_pixel.jar
decx process list
decx process close framework_google_pixel
decx process close --port 25419
```

**Common framework options:**

| Option | Description |
|--------|-------------|
| `--source-dir <dir>` | Framework source directory |
| `--out-dir <dir>` | Framework output directory |
| `--adb-path <path>` | ADB executable path |
| `--serial <serial>` | ADB device serial |
| `--clean-source` | Remove `source/` after the command finishes successfully |

**run/open options:**

| Option | Description |
|--------|-------------|
| `--no-open` | Do not open the generated framework jar after packing |
| `-n, --name <name>` | Custom DECX session name when opening the jar |
| `--port <port>` | Server port when opening the jar |

**Artifact naming**

Packed framework artifacts are named:

```text
framework_<brand>_<vendor>.jar
```

Artifact segments are resolved like this:

1. `brand` is the detected device OEM for `collect/run`, or the resolved `oem` used by `process`
2. `vendor` comes from the persisted `.artifact.json` record
3. During `framework collect` / `framework run`, vendor is resolved from:
   `adb shell getprop ro.product.model`
4. If no artifact record exists, `vendor` falls back to `unknown`
5. Framework artifact metadata is stored alongside the output under `.artifact.json`
6. `framework open` and `framework run` create normal DECX process sessions with the default session name `framework_<brand>_<vendor>`
7. `framework collect` and `framework process` only prepare artifacts; they do not create a running session

**Platform notes**

- Windows is not supported for `decx android framework` yet
- Framework tooling checks the current system first: `adb` or `--adb-path`, system `debugfs`, then system `fsck.erofs` / `extract.erofs`
- If a required framework tool is missing, the CLI falls back to packaged native tools for supported Darwin/Linux targets
- Packaged native tools are distributed as `dist/bin.tar.gz`; they are not unpacked during `npm install`
- Packaged tools are unpacked lazily when needed into `$DECX_HOME/cache/bin/decx-cli/<archive-hash>/`, or `~/.decx/cache/bin/decx-cli/<archive-hash>/` when `DECX_HOME` is not set
- `framework open` and `framework run` reuse the normal `decx process open` flow
- After a framework jar is opened, use the existing `decx process` commands to inspect or close that session
- `framework open` uses an explicit jar path when provided; otherwise it resolves the jar for the currently connected device OEM
- Temporary processing directories are removed only after the command reaches its final step
- `source/` is preserved by default and is removed only when `--clean-source` is set
- If `adb devices` reports exactly one connected device, framework commands use it automatically
- If multiple devices are connected, pass `--serial <serial>` to select the target device
- `collect` and `run` detect the device OEM from adb properties; `process [oem]` uses an explicit value, `.artifact.json`, or a connected device in that order

### self update notes

- `decx self update` updates the DECX server JAR first, then runs `npm install -g <current-package-name>@latest`
- The CLI package name is resolved from the installed package metadata instead of being hardcoded
- `-p/--prerelease` currently affects the server JAR update path only
- The CLI update step assumes the CLI was installed with global `npm`; if you installed it another way, update the package manager command yourself
- On Windows, CLI versions older than v4.0.1 can fail with `spawnSync npm.cmd EINVAL`. Because the affected updater cannot bootstrap its own fix, run `npm.cmd install -g @jygzyc/decx-cli@latest` once from PowerShell or CMD, reopen the terminal, and verify `decx --version` reports v4.0.1 or newer. Use `where.exe decx` if PATH still selects an older installation

### code

```bash
decx code classes                    # Get classes; supports --include-package/--exclude-package
decx code class-context <class>          # Get class information
decx code class-source <class> [--limit <n>] # Get class source code (--smali for Smali)
decx code method-source <sig>            # Get method source (--smali for Smali)
decx code method-context <sig>           # Get method signature, callers, and callees
decx code method-cfg <sig>               # Get method control flow graph as DOT source
decx code search-global <keyword> [--limit <n>]  # Regex by default; supports --no-regex
decx code search-class <class> <pattern> --limit <n>  # Regex by default; supports --no-regex
decx code search-method <name>           # Search methods by name
decx code xref-method <sig>              # Find method callers
decx code xref-class <class>             # Find class usages
decx code xref-field <field>             # Find field usages
decx code implementations <interface>          # Find implementations
decx code subclasses <class>               # Find subclasses
```

### Global options

| Option | Description |
|--------|-------------|
| `-s, --session <name>` | Target session name |
| `--port <port>` | Server port (default: auto-assigned in 30000–40000) |
| `--page <n>` | Page number (default: 1) |

## Method signature format

For `code method-source` and `code xref-method`:

```
package.Class.methodName(paramType1,paramType2):returnType
```

Example: `com.example.MainActivity.onCreate(android.os.Bundle):void`

## Development

```bash
npm install       # install dependencies
npm run build     # build to dist/
npm test          # run tests
npm run lint      # lint check
npm run dev       # run locally
```

`npm run build` type-checks the TypeScript sources, then writes a compact runtime package under `dist/`:

```text
dist/index.js      # CLI entry
dist/sdk/index.js  # SDK import entry
dist/bin.tar.gz    # packaged native framework tools
dist/package.json  # package metadata for the built artifact
```

The published npm package is limited to the built `dist/` artifact plus npm's required package metadata and README.

## License

GNU-3.0
