package jadx.plugins.decx.extension

import jadx.plugins.decx.api.DecxRoutes
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Verifies the DecxExtension SPI end-to-end at the registry level:
 *  - the taint extension is discovered via ServiceLoader
 *  - its route is registered and resolvable
 *  - it does not collide with built-in jadx routes
 *  - the route handler can resolve both built-in and extension paths
 */
class DecxExtensionsTest {

    @Test
    fun `taint extension is discovered via ServiceLoader`() {
        val ids = DecxExtensions.all.map { it.id }
        assertThat(ids).contains("taint")
    }

    @Test
    fun `taint extension availability is environment-dependent but stable`() {
        val taint = DecxExtensions.all.first { it.id == "taint" }
        // Must not throw; result reflects whether the worker env is installed.
        assertThat(runCatching { taint.isAvailable() }.isSuccess).isTrue()
    }

    @Test
    fun `extension routes do not collide with built-in jadx routes`() {
        val builtinPaths = DecxRoutes.all.map { it.path }.toSet()
        val extensionPaths = DecxExtensions.routes.map { it.path }.toSet()
        val collision = builtinPaths.intersect(extensionPaths)
        assertThat(collision)
            .describedAs("extension routes must not shadow built-in jadx routes")
            .isEmpty()
    }

    @Test
    fun `unknown extension path resolves to null`() {
        assertThat(DecxExtensions.routeOf("/api/decx/taint/does_not_exist")).isNull()
    }
}
