## Composite Native Chains

The native track is deliberately thin: routing is the tool entry plus the object, and every row below came from a traced hunt rather than from a template.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| unknown vendor module (`.ko` ET_REL, no vendor source, no linked image) → user-space-reachable dispatch → privileged sink | the attack path must be mapped from an entry a caller can reach (device node `ioctl` / `file_operations`), never from `init_module` | [[patterns/native-kernel_modules]] |

## Single Pattern Routing

| Observed signal | Primary direction | Load first |
|---|---|---|
| analysing a `.ko`/ET_REL object directly (`kuna functions` / `decompile` / `xrefs` / `strings`), with or without a loaded device | object-level analysis, not a dead end when a result is empty | [[patterns/native-kernel_modules]] |
| vendor kernel module, camera/ISP/actuator driver, `/vendor/lib/modules`, unreadable module files on a live device | module surface mapping | [[patterns/native-kernel_modules]] |

## Bootstrap Note

- One card today, no measured rollout: native rows are added from traces, not authored up front. Treat the entries above as routing, not as a validated method.
- `decx-poc` has no native harness reference yet (`references/android-poc-*.md` is the Android set), so a native finding stops at the writeup unless the user asks for a harness.
