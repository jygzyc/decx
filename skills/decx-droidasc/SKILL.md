---
name: decx-droidasc
description: Use when decompiling or cross-referencing DEX code with DroidASC (the upstream project formerly ASC) — one Java/Kotlin class from an APK/JAR, the decoded AndroidManifest.xml, string/type/method/field references, or the GUI. Covers exact `getclass`/`getmanifest`/`findrefs` syntax, identifier forms, output and error contracts, and which containers DroidASC accepts.
metadata:
  requires:
    bins: ["droidasc"]
---

# DroidASC

DroidASC reads an APK/JAR container, extracts the DEX entries it needs in memory, and
decompiles or searches on demand. It is stateless: pass the container on every command.
Upstream 0.1.0 renamed the project **ASC → DroidASC** and repackaged the tree as the
`droidasc` package (console script `droidasc`, PyPI `pip install droidasc`, Python
>= 3.10); `main.py` is now a shim over it. DECX uses `droidasc` as the tool id and launcher, so
`decx run droidasc …` runs exactly this CLI — the command grammar below is unchanged.

## Routing Gate

Use for DEX code inside a ZIP-family container (APK, JAR), including the packed
framework jar AFE produces.

Do not use it for native code (-> `decx-kuna`) or for collecting framework files
(-> `decx-afe`). A bare `.dex` file is not an input: re-container it first, otherwise
DroidASC exits 1 with `Error: EOCD not found`.

## Commands

```text
droidasc getclass <container> <dalvik-class> [--threads N] [--debug] [-o FILE]
droidasc getmanifest <container> [--debug] [-o FILE]
droidasc findrefs <container> [--threads N] [--debug] <string|type|method|field> ...
droidasc <container> --gui [--threads N] [--debug]
```

| Command | Purpose |
|---|---|
| `droidasc getclass "<container>" "<class>"` | Locate one class, extract its DEX in memory, decompile to stdout |
| `droidasc getclass "<container>" "<class>" -o "<file>"` | Same, also writing the source to `<file>` |
| `droidasc getmanifest "<container>" [-o "<file>"]` | Decode `AndroidManifest.xml` as XML |
| `droidasc findrefs "<container>" string "<value>"` | References to a fuzzy string across all DEX entries |
| `droidasc findrefs "<container>" type "<value>"` | References to a fuzzy type descriptor/name |
| `droidasc findrefs "<container>" method "<name>" [--class C \| --fuzzy-class]` | References to methods |
| `droidasc findrefs "<container>" field "<name>" [--class C \| --fuzzy-class]` | References to fields |
| `droidasc "<container>" --gui` | Launch the GUI (see below) |

- Argument order is fixed: `getclass` takes `<container>` then `<class>`; `findrefs`
  takes `<container>`, then `--threads N` / `--debug` if used, then the kind, then the
  name and `--class` / `--fuzzy-class`. `-o FILE` writes the same text that goes to stdout.
- `--threads N` (alias `--thread`, default 8) is defined on `getclass` and `findrefs`;
  `--debug` and `-o` / `--output` are defined on all three subcommands — place them on the
  subcommand, before the `findrefs` kind, not after it.
- `string` and `type` take exactly one `<value>`; `method` and `field` take an optional
  `<name>` and require at least one of name or `--class`.
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

- Exit `0` on success, `1` on a failed check, `2` on a usage error; `--debug` adds
  `[DEBUG]` profiling lines (hit DEX, scan and total times).
- `findrefs` streams matching lines grouped per DEX entry; no matches prints nothing and
  exits 0 — an empty result is a real result, not a command failure.
- `getclass` on a missing class: exit 1, `Error: Class <dalvik-class> not found in APK.`
  (the class is normalized before the lookup).
- A non-ZIP input: exit 1, `Error: EOCD not found`.
- When a flag or positional is uncertain, `droidasc --help` /
  `droidasc <subcommand> --help` is the authority — do not guess.

## Install

```bash
decx install droidasc   # private venv over the pinned subprojects/decx-droidasc/source checkout
decx run droidasc getclass "<container>" "<class>"
```

- DECX installs the pinned checkout, not PyPI: the venv gets `androguard==4.1.3` from
  `requirements.txt`, the manager copies the `droidasc/` package next to `main.py`, and
  the `droidasc` launcher (`droidasc.cmd` on Windows) runs that entry point.
- The install needs Python >= 3.10 on PATH (`DECX_PYTHON` picks another interpreter, otherwise
  the install fails naming the shortfall); the launcher runs the installed copy under
  `<DECX_HOME>/share/droidasc/`, not the vendored checkout, and there is no source build —
  `--from-source` and `--source` do not apply here (exit 2, `USAGE`: "droidasc installs from
  its Python checkout").
- Upstream's own entry points are the `droidasc` console script and
  `python -m droidasc`; they are the same CLI shown above.

Maintenance record (evidence, history, pattern pages): `wiki/` — read by the maintainer/proposer, never during execution.

