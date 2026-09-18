---
name: decx-kuna
description: Use when analyzing a native binary with Kuna — ELF/PE/Mach-O and relocatable objects such as vendor kernel modules — for function inventories, decompilation, cross-references, strings, disassembly, hexdump reads and unpacking. Covers the exact subcommands and shared flags, generated symbol names, ET_REL semantics, and the JSON/error contracts.
metadata:
  requires:
    bins: ["kuna"]
---

# Kuna

Kuna reads ELF, PE and Mach-O binaries and relocatable objects, and analyzes them
statically. Every subcommand is stateless: pass the binary on every command.

## Routing Gate

Use for native code — shared libraries, executables, kernel modules and `.o` files.

Do not use it for DEX/Java code (-> `decx-droidasc`) or for collecting framework files
(-> `decx-afe`). JVM code is invisible to Kuna and native code is invisible to DroidASC, so
an app shipping both normally needs both skills.

## Commands

| Command | Purpose |
|---|---|
| `kuna functions "<binary>" [--json] [--jobs N\|auto]` | Whole-binary function inventory; unnamed functions get `sub_<addr>` names |
| `kuna decompile "<binary>" "<func\|0xaddr>" [--addr] [--json]` | Decompile one function (`--addr` when the selector is an address) |
| `kuna decompile-all "<binary>" [--json] [--functions a,b,…] [--addr 0xVMA] [--no-vars]` | Decompile every discovered function |
| `kuna decompile-project "<binary>" [-o DIR]` | Recompile-oriented project export |
| `kuna decompile-graph "<binary>" [-o FILE] [--label TEXT]` | Whole program as one JSON graph |
| `kuna xrefs "<binary>" (--to\|--from) "<name\|0xaddr>" [--kind call,jump,data,read,write] [--json]` | Cross-references into / out of a function or address |
| `kuna disassemble "<binary>" "<name\|0xaddr\|0xstart-0xend>" [--addr] [--as code\|data\|auto] [--json]` | Instructions for a function or an address range |
| `kuna read "<binary>" "<sel>" [--addr] [--bytes N] [--json]` | Hexdump view of the same selector |
| `kuna strings "<binary>" [--json] [--min-length N] [--filter REGEX] [--encoding ascii\|utf16\|all] [--section NAME] [--no-xrefs]` | String inventory with owner attribution |
| `kuna unpack "<binary>" [-o OUT] [--json]` | Statically unpack UPX- or NEOLite-packed input |
| `kuna docs [<topic>] [--json] [--all]` | Upstream documentation topics |

`kuna <subcommand> --help` prints the usage block, the flag list and the shape of that
command's `--json` document and exits 0 without an input binary; help goes to stderr.

## Flags

```text
--isa auto|arm|thumb        instruction set when auto-detection is not enough
--json                      machine-readable output; schema in `kuna <cmd> --help`
--mode auto|reliable|aggressive|fast    option preset (`kuna modes`)
--option NAME VALUE         repeatable; unknown names exit 2 (`kuna catalog` lists them)
--max-fn-seconds N          per-function budget
--define-function S[-E][=N]|@FILE       force/name functions
--assert DIRECTIVE|@FILE    phase assertions
--slice ARCH                pick one arch of a universal Mach-O
--raw-image --target T --base VMA       raw firmware images (entry/address required)
```

- Generated `sub_<addr>` names are real selectors: pass them to `decompile`, `xrefs` or
  `disassemble` exactly as the inventory printed them.
- `--option` names are case- and separator-sensitive; an unknown name exits 2 and
  suggests the nearest catalogued spelling.
- `xrefs` selects by `--to` / `--from` only — there is no `--function` flag. A
  `"count": 0` answer means "no call sites found", not "stripped", so an empty xref set
  is not by itself a dead end.
- `--json` output stays clean on stdout; diagnostics and the build-mismatch warning go
  to stderr.

## Input handling worth knowing

- Relocatable objects (`.ko` kernel modules, `.o` files) are read as ET_REL input: the
  same `functions`, `decompile` and `xrefs` commands work on an unlinked object with no
  relocation step, addresses are based at the module base (`0x400000`), and every
  function reports `object_location {section_index, section, offset}` — that section
  offset, not the base address, is what maps back into the packaged `.ko`. A module has
  no `main`: triage starts from the dispatch a caller can reach (the `file_operations` /
  `unlocked_ioctl` pair behind the device node), then follows the `copy_from_user` path.
- An ELF whose section table is unusable is still loaded from its program headers (a note
  goes to stderr); PE data-directory-count corruption is clamped the same way.
- A UPX-packed image is section-less; `kuna unpack` is the intended next step.
- `strings` scans per section: a module without `.rodata`/`.modinfo` legitimately prints
  `0 strings`, so an empty result is not evidence of packing.
- Every image-reading surface (functions, decompile, decompile-all, strings, xrefs,
  disassemble, decompile-graph, decompile-project) honors `--slice ARCH`.

`kuna test`, `kuna specs` and `kuna fid` are project maintenance surfaces (parity gates,
SLEIGH compilation, function-ID libraries), not analysis commands. Kuna has no GUI mode.

## Output and Errors

- Without `--json`, output is human text; with `--json`, one JSON document per run.
- `kuna --help` lists subcommands and exits 0; an unknown subcommand exits 2 with
  `kuna: unknown subcommand "<x>"` plus usage.

## Install

```bash
decx install kuna                 # pinned upstream release plus the SLEIGH specs archive
decx install kuna --version <tag> # another release tag
decx run kuna functions "<binary>" --json
```

- The manifest pins release `v1.515` (tag prefix `v`): `install` takes the host platform's
  asset plus the separate `specs` archive, installs both under `<DECX_HOME>/share/kuna/`,
  and verifies the download structurally — upstream publishes no checksum file.
- Three launchers are linked — `kuna`, `decomp_dbg`, `slacomp` — and `kuna`'s generated
  launcher exports `KUNA_SPECS`, so the SLEIGH specs are found without shell setup.
- There is no source build: `--from-source` is rejected for this tool (`NO_SOURCE_BUILD`,
  "kuna has no source build information").

Maintenance record (evidence, history, pattern pages): `wiki/` — read by the maintainer/proposer, never during execution.

