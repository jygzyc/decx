---
name: decx-tool
description: Use when driving any installed DECX native tool — DroidASC (DEX decompiling and cross-referencing inside an APK/JAR container), Kuna (native binary and ET_REL decompilation, xrefs, strings, unpacking) or AFE (Android framework collection and preprocessing, live device reads). Routes between the three; each tool's exact commands, identifier forms, output and error contracts and install method live in its reference file. Never a unified command tree: nothing translates one tool's commands into another's.
metadata:
  requires:
    bins: ["decx"]
---

# DECX Tools

One skill for the three native tools the manager installs: `droidasc`, `kuna` and
`afe`. Each tool keeps its own command grammar, output and errors — run the tool's
own CLI and consume its own output; DECX never translates one tool's commands into
another's. Each tool's full contract lives in its own reference, loaded only when
that tool is used:

- [`references/droidasc.md`](references/droidasc.md) — command grammar, class-name
  normalization, output and error contract, install.
- [`references/kuna.md`](references/kuna.md) — upstream's own Kuna skill, copied
  verbatim from the pinned checkout (frontmatter dropped); re-copy it when the pin
  moves, never edit it.
- [`references/afe.md`](references/afe.md) — collect/process/pack commands, device
  queries, artifact flow, install.

## Routing Gate

| Task / input | Tool |
|---|---|
| DEX code inside a ZIP-family container (APK, JAR), including the packed framework jar AFE produces | `droidasc` |
| Native binaries and ET_REL objects | `kuna` |
| Android framework collection and preprocessing, live device reads (`afe device ...`) | `afe` |

- A framework target is a three-tool flow: `afe collect` → `afe process` →
  `droidasc` on the packed jar, with `kuna` for the native libraries it carries.
  AFE never decompiles and never starts an analyzer.
- A bare `.dex` file is not a DroidASC input: re-container it first, otherwise
  DroidASC exits 1 with `Error: EOCD not found`.
- When a flag or positional is uncertain, the tool's own `--help` is the
  authority — do not guess and do not re-express one tool's grammar in another's
  terms.

## Install and Launch

```bash
decx install <tool>             # droidasc | kuna | afe
decx -m <tool> -- <args...>     # runs the installed launcher; args pass through unchanged
```

- `droidasc` installs as a private venv over the pinned upstream checkout when
  available — see
  [`references/droidasc.md`](references/droidasc.md) `## Install`.
- `kuna` installs from the pinned release archive plus the separate compiled SLEIGH
  specs archive. The generated launcher exports `KUNA_SPECS` at the specs directory,
  so the binary finds its SLEIGH languages without shell setup — without it Kuna
  decodes nothing (`No sleigh specification for AARCH64:LE:64:v8A`). Platforms with
  an upstream asset: `<os>-<arch>` (`win`/`darwin`/`linux` × `arm64`/`amd64`, e.g.
  `darwin-arm64`, `win-amd64`); a host
  without one fails loudly instead of compiling `source/` (installs never use the
  vendored checkout, and `--from-source` is not offered for kuna).
- `afe` installs the prebuilt `tools-v*` asset when it carries this platform,
  otherwise it builds its Rust crate with cargo — see
  [`references/afe.md`](references/afe.md) `## Install`.
