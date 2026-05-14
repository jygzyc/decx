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
| `decx ard` | Android specific analysis |
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
decx self update [-p]           # Update decx-server.jar and the currently installed npm CLI package
```

**open options:**

| Option | Description |
|--------|-------------|
| `-P, --port <port>` | Server port |
| `--force` | Force start even if session exists |
| `-n, --name <name>` | Custom session name |

All standard [jadx-cli options](https://github.com/skylot/jadx) are passed through directly. `decx process open` enables `--show-bad-code` by default, and common passthrough options also include `--deobf`, `--no-res`, `-j`/`--threads-count`, `--no-imports`, `--no-debug-info`, `--escape-unicode`, `--log-level`.

### ard

```bash
decx ard app-manifest                    # Get AndroidManifest.xml
decx ard main-activity                   # Get main activity name
decx ard app-application                 # Get Application class name
decx ard exported-components [--type <pattern>] [--no-regex] # List exported components
decx ard app-deeplinks                   # List deep link schemes
decx ard app-receivers [--limit <n>] [--include-package <pattern>] [--exclude-package <pattern>] [--no-regex] # List dynamic broadcast receivers
decx ard system-service-impl <interface> # Find system service implementations
decx ard system-services [--serial <serial>] [--grep <kw>] # List Android system services as structured JSON
decx ard perm-info <permission> [--serial <serial>]        # Show structured permission details
decx ard all-resources [--include <pattern>] [--no-regex] # List resource file names
decx ard resource-file <res>             # Get resource file content
decx ard strings                         # Get strings.xml content
decx ard get-aidl [--limit <n>] [--include-package <pattern>] [--exclude-package <pattern>] [--no-regex] # Get AIDL interfaces
decx ard framework collect               # Collect framework files from the connected device
decx ard framework process <oem>         # Process local framework source files and pack the framework jar
decx ard framework run                   # Collect, process, pack, and optionally open
decx ard framework open [jar]            # Open the generated framework jar or a provided JAR
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

`perm-info` returns one parsed permission object instead of raw shell text:

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
decx ard system-services --serial emulator-5554
decx ard system-services --serial emulator-5554 --grep permission
decx ard perm-info android.permission.DUMP --serial emulator-5554
```

### ard framework

`decx ard framework` integrates the archived preprocessor workflow into the native CLI.
It supports both end-to-end collection from a connected Android device and offline
processing of an existing local framework dump.

Framework artifacts are not treated as a separate runtime session type.
Only `framework open` and `framework run` start a DECX server, and once opened they
are managed exactly like any other DECX session through `decx process list`,
`decx process status`, and `decx process close`.

```bash
decx ard framework run
decx ard framework run --no-open
decx ard framework collect --serial emulator-5554
decx ard framework process google --out-dir ~/.decx/output/framework/google
decx ard framework open
decx ard framework open ~/.decx/output/framework/google/framework_google_pixel.jar
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
| `-P, --port <port>` | Server port when opening the jar |

**Artifact naming**

Packed framework artifacts are named:

```text
framework_<brand>_<vendor>.jar
```

Artifact segments are resolved like this:

1. `brand` is the detected device OEM for `collect/run`, or the explicit `oem` passed to `process`
2. `vendor` comes from the persisted `.artifact.json` record
3. During `framework collect` / `framework run`, vendor is resolved from:
   `adb shell getprop ro.product.model`
4. If no artifact record exists, `vendor` falls back to `unknown`
5. Framework artifact metadata is stored alongside the output under `.artifact.json`
6. `framework open` and `framework run` create normal DECX process sessions with the default session name `framework_<brand>_<vendor>`
7. `framework collect` and `framework process` only prepare artifacts; they do not create a running session

**Platform notes**

- Windows is not supported for `decx ard framework` yet
- The CLI ships packaged extractor binaries for supported Darwin/Linux targets
- `framework open` and `framework run` reuse the normal `decx process open` flow
- After a framework jar is opened, use the existing `decx process` commands to inspect or close that session
- `framework open` uses an explicit jar path when provided; otherwise it resolves the jar for the currently connected device OEM
- Temporary processing directories are removed only after the command reaches its final step
- `source/` is preserved by default and is removed only when `--clean-source` is set
- If `adb devices` reports exactly one connected device, framework commands use it automatically
- If multiple devices are connected, pass `--serial <serial>` to select the target device
- `collect` and `run` detect the device OEM from adb properties; `process` requires an explicit `oem`

### self update notes

- `decx self update` updates the DECX server JAR first, then runs `npm install -g <current-package-name>@latest`
- The CLI package name is resolved from the installed package metadata instead of being hardcoded
- `-p/--prerelease` currently affects the server JAR update path only
- The CLI update step assumes the CLI was installed with global `npm`; if you installed it another way, update the package manager command yourself

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
decx code implement <interface>          # Find implementations
decx code subclass <class>               # Find subclasses
```

### Global options

| Option | Description |
|--------|-------------|
| `-s, --session <name>` | Target session name |
| `-P, --port <port>` | Server port (default: 25419) |
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

## License

GNU-3.0
