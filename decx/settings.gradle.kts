rootProject.name = "jadx_decx_plugin"
include("decx-core")
include("decx-plugin")
include("decx-server")
// Server-side taint extension (DecxExtension SPI implementation) plus the
// Tai-e worker sources. decx-core has no taint code; taint routes/tools exist
// only when this module is on the classpath (bundled by decx-server /
// decx-plugin). The Tai-e engine is fetched from its official release zip at
// build time and never enters any shipped jar.
include("decx-taint")
