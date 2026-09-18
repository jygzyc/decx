---
name: kernel_modules
track: native
---

# kernel_modules

## Match
Analysing a vendor kernel module with no vendor source or linked image when the attack path must be mapped from a reachable entry point. The module is a `.ko` relocatable ET_REL object - typically a camera/ISP/actuator driver under `/vendor/lib/modules` - and the entry point must be one a user-space caller can actually reach.

## Non-obvious
- kuna reads ET_REL objects directly: `kuna functions <obj> --json` returned `kuna_crc32`/`kuna_strlen`/`kuna_memset` with addresses based at the module base (`0x400000`), and every function carried `object_location {section_index, section, offset}` - that section offset, not the base address, is what maps back into the packaged `.ko`.
- `kuna decompile <obj> <name> --json` works on the same object and emits C (`"language": "c-language"`) without any linked image, so a `.ko` can be decompiled before it is ever loaded.
- `kuna xrefs <obj> --to <name>` (or `--from <name>`) is the only xref form; `--function` fails with `unknown option`. A `"count": 0` result means "no call sites found", not "stripped", so an empty xref set must not be read as a dead end.
- `kuna strings <obj> --min-length N` scans per section; a module without `.rodata`/`.modinfo` prints `0 strings`, so an empty result is not evidence of packing or encryption.
- Start from the dispatch, not from `init_module`: a driver module's reachable surface is the `file_operations`/`unlocked_ioctl` pair behind its device node, so find the ioctl plus `copy_from_user` path first and decompile helpers only as they are needed.
- On a live device the module files are usually unreadable from the shell even though `/proc/modules` is readable (`/vendor/lib/modules/*.ko` on a vivo V2324A returned Permission denied as uid 2000), so pull the module from the `vendor_dlkm`/boot image or a rooted shell instead of reading `/vendor` over adb.

## Reject
Not a finding: this is tooling knowledge used while building an exploitation path, and it never enters a report on its own.
