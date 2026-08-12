rootProject.name = "jadx_decx_plugin"
include("decx-core")
include("decx-plugin")
include("decx-server")
// PoC module for Tai-e taint analysis integration. Disposable.
include("decx-taint-poc")
// Taint engine: protocol module shared by core (orchestrator) and worker (Tai-e).
include("decx-taint-protocol")
include("decx-taint-worker")
