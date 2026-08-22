package jadx.plugins.decx.taint

import jadx.plugins.decx.extension.DecxExtension
import jadx.plugins.decx.extension.DecxExtensions
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.util.ServiceLoader

/**
 * Verifies that the taint extension is loadable as a plugin: decx-core
 * discovers it via the DecxExtension SPI (ServiceLoader), so taint routes and
 * MCP tools exist only when this module is on the classpath.
 */
class TaintExtensionDiscoveryTest {

    @Test
    fun `taint extension is registered via ServiceLoader`() {
        val impls = ServiceLoader.load(DecxExtension::class.java).toList()
        assertThat(impls.map { it.id }).contains("taint")
    }

    @Test
    fun `taint extension is visible to the core registry`() {
        assertThat(DecxExtensions.all.map { it.id }).contains("taint")
        // Routes are gated by availability: without the Tai-e worker
        // environment the extension contributes no routes.
        val taintAvailable = DecxExtensions.all.first { it.id == "taint" }.isAvailable()
        val route = DecxExtensions.routeOf("/api/decx/taint/config")
        assertThat(route != null).isEqualTo(taintAvailable)
    }
}
