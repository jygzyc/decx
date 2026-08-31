# DECX v4.2.0

DECX v4.2.0 bounds the analysis server's memory usage, makes `--force` session replacement leak-proof, and replaces smali-text scans with fast metadata hierarchy checks.

### Features

- **Bounded decompiler memory (headless server)**: `decx-server` now installs a byte-bounded LRU code cache in place of JADX's unbounded in-memory cache (default `min(4GB, heap/2)`, override with `-Ddecx.decompile.codeCacheMaxBytes`) and unloads evicted classes on a daemon worker — releasing method bodies / CFG / cached smali that previously stayed resident forever. The unload queue is bounded and backpressured: when full, decompilation waits for the worker, so evicted-but-unloaded state is hard-bounded. Large APKs can no longer grow the heap until the free-heap guard starts refusing all decompiles. `/health` reports code-cache entries/bytes/evictions and pending unloads.
- **Verified session kill**: `killProcessGroup` now verifies actual process death and reports `killed` / `already-dead` / `failed`. `--force` refuses to spawn a duplicate server and `process close` keeps the session record when the old JVM survives, so failed kills can no longer silently orphan memory-eating JVMs.
- **`process open` heartbeat and `--timeout`**: while waiting for the server to become healthy, progress heartbeats (elapsed time + last log line) go to stderr roughly every 15s, and `--timeout <seconds>` (default 300) bounds the wait; on timeout with the JVM still alive the session is kept and the error suggests `decx process check` / `decx process close`.

### Fixes

- **Interface and subclass scans**: `get_implementations` previously always returned empty — the smali scan searched for `.implement` while baksmali emits `.implements` — and inner classes were matched with `.` instead of `$`. All hierarchy scans (`get_implementations`, `get_subclasses`, `get_aidl_interfaces`, `get_system_service_impl`, `get_dynamic_receivers`) now read dex metadata (`ClassNode` superclass / interfaces) directly: correct, much faster, and no longer caching full disassembly text for every scanned class. Declarations made by nested (inner / inlined) classes are attributed to the outer class, so "which Activity handles onClick" still resolves to the outer class name.

### Changes

- Dependency bumps applied from pending Dependabot PRs (Kotlin 2.4.10, Gson 2.14.0, JUnit 6.1.3, Logback 1.6.2, kotlin-logging 8.0.4, Gradle actions, npm globals).
