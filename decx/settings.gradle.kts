rootProject.name = "jadx_decx_plugin"
include("decx-core")
include("decx-plugin")
include("decx-server")
// PoC module for Tai-e taint analysis integration. Disposable.
include("decx-taint-poc")
// Taint engine: protocol module shared by core (orchestrator) and worker (Tai-e).
include("decx-taint-protocol")
include("decx-taint-worker")
// Server-side taint extension (DecxExtension SPI implementation). decx-core
// has no taint code; taint routes/tools exist only when this module is on the
// classpath (bundled by decx-server / decx-plugin).
include("decx-taint")
