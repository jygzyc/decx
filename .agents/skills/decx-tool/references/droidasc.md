# DroidASC

DroidASC reads an APK/JAR ZIP-family container, extracts the DEX entries it needs in
memory, and decompiles or searches on demand across the container's DEX files. It is
stateless: pass the container on every command.
Upstream 0.1.0 renamed the project **ASC → DroidASC** and repackaged the tree as the
`droidasc` package (console script `droidasc`, PyPI `pip install droidasc`, Python
>= 3.10); `main.py` is now a shim over it. DECX uses `droidasc` as the tool id and launcher, so
`decx -m droidasc …` runs exactly this CLI — the command grammar below is unchanged.

## Commands

```text
droidasc getclass <container> <dalvik-class> [--threads N] [--debug] [-o FILE]
droidasc listclass <container> [--prefix PREFIX] [--threads N] [--debug] [-o FILE]
droidasc getmanifest <container> [--debug] [-o FILE]
droidasc findrefs <container> [--threads N] [--debug] <string|type|method|field> ...
droidasc <container> --gui [--threads N] [--debug]
```

| Command | Purpose |
|---|---|
| `droidasc getclass "<container>" "<class>"` | Locate one class, extract its DEX in memory, decompile to stdout |
| `droidasc getclass "<container>" "<class>" -o "<file>"` | Same, also writing the source to `<file>` |
| `droidasc listclass "<container>" [--prefix "<prefix>"]` | Class names across all DEX entries, one per line, optional prefix filter |
| `droidasc listclass "<container>" -o "<file>"` | Same, writing the class list to `<file>` |
| `droidasc getmanifest "<container>" [-o "<file>"]` | Decode `AndroidManifest.xml` as XML |
| `droidasc findrefs "<container>" string "<value>"` | References to a fuzzy string across all DEX entries |
| `droidasc findrefs "<container>" type "<value>"` | References to a fuzzy type descriptor/name |
| `droidasc findrefs "<container>" method "<name>" [--class C \| --fuzzy-class]` | References to methods |
| `droidasc findrefs "<container>" field "<name>" [--class C \| --fuzzy-class]` | References to fields |
| `droidasc "<container>" --gui` | Launch the GUI (see below) |

- Argument order is fixed: `getclass` takes `<container>` then `<class>`; `findrefs`
  takes `<container>`, then `--threads N` / `--debug` if used, then the kind, then the
  name and `--class` / `--fuzzy-class`. `-o FILE` writes the same text that goes to stdout.
- `--threads N` (alias `--thread`, default 8) is defined on `getclass`, `listclass` and
  `findrefs`;
  `--debug` and `-o` / `--output` are defined on all four subcommands — place them on the
  subcommand, before the `findrefs` kind, not after it.
- `string` and `type` take exactly one `<value>`; `method` and `field` take an optional
  `<name>` and require at least one of name or `--class`.
- `string` and `type` values are fuzzy matches. `method` and `field` names are also
  fuzzy; use `--class` to scope them, and add `--fuzzy-class` only when that class
  value is a pattern rather than one exact class. A class-only query is valid.
- `findrefs` searches all DEX entries and streams matching lines grouped by entry.
  No matching lines with exit 0 means no references were found; it is not an error.
- `listclass` prints one class name per line in Dalvik descriptor form (`Lcom/poc/Main;`)
  across every DEX entry. `--prefix` accepts a dotted or descriptor prefix and normalizes
  it (`com.poc` → `Lcom/poc`); an empty prefix after stripping is a usage error.
- `--fuzzy-class` switches `--class` from an exact class (normalized Dalvik form) to a
  fuzzy pattern such as `MainActivity` or `poc`.
- `--gui` is intercepted before argparse, so it may sit anywhere in the argument list,
  and it has its own parser that accepts only `<container>`, `--threads`/`--thread`,
  `--debug` and the hidden `--gui-foreground`; subcommand flags are rejected there.
  Without `--debug`/`--gui-foreground`, `droidasc "<container>" --gui` spawns a detached
  child (`python -m droidasc … --gui-foreground`, stdio to `DEVNULL`, new
  session/process group) and returns immediately: exit 0 means the child started, not
  that a window opened. `--debug` or `--gui-foreground` runs the GUI in-process, which
  blocks and keeps the logs.

Class names accept every form and normalize to the same class; exactly one class per
`getclass` invocation, so re-issue the command for another class:

```text
com.poc.Main    com/poc/Main    Lcom/poc/Main;
```

Method and field queries take a fuzzy name plus an optional class scope:

```bash
droidasc findrefs "app.apk" method "onCreate" --class "com.poc.Main"
droidasc findrefs "app.apk" method "notify" --class "MainActivity" --fuzzy-class
droidasc findrefs "app.apk" field "apiKey" -o field_refs.txt
```

## Output and Errors

- Exit `0` on success, `1` on a failed check, `2` on a usage error. Errors are
  printed to stderr; `--debug` adds `[DEBUG]` profiling lines (hit DEX, scan and
  total times) to stdout.
- `findrefs` streams matching lines grouped per DEX entry; no matches prints nothing and
  exits 0 — an empty result is a real result, not a command failure.
- `getclass` on a missing class: exit 1, `Error: Class <dalvik-class> not found in APK.`
  (the class is normalized before the lookup).
- A non-ZIP input: exit 1, `Error: EOCD not found`.
- When a flag or positional is uncertain, `droidasc --help` /
  `droidasc <subcommand> --help` is the authority — do not guess.

## Install

```bash
decx install droidasc   # private venv installing the published PyPI package
decx -m droidasc getclass "<container>" "<class>"
```

- DECX creates a private environment under `<DECX_HOME>/runtime/droidasc/` and
  installs the published `droidasc` PyPI distribution with pip. The manager records
  provenance in `<DECX_HOME>/share/droidasc/PROVENANCE`; it needs no source tree.
- The install needs Python >= 3.10 on PATH (`DECX_PYTHON` picks another interpreter,
  otherwise the install fails naming the shortfall). `--version <version>` pins the
  PyPI distribution. Source-build flags do not apply to this tool.
- Upstream's own entry points are the `droidasc` console script and
  `python -m droidasc`; they are the same CLI shown above.
