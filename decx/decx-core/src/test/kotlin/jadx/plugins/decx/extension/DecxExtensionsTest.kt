package jadx.plugins.decx.extension

import jadx.plugins.decx.api.DecxRoutes
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Verifies the DecxExtension SPI end-to-end at the registry level:
 *  - a test extension is discovered via ServiceLoader
 *  - its route is registered and resolvable
 *  - it does not collide with built-in jadx routes
 *  - the route handler can resolve both built-in and extension paths
 *
 * The real taint extension lives in the decx-taint module and is covered by
 * its own discovery test there; decx-core itself has no taint code.
 */
class DecxExtensionsTest {

    @Test
    fun `test extension is discovered via ServiceLoader`() {
        val ids = DecxExtensions.all.map { it.id }
        assertThat(ids).contains("test-ext")
    }

    @Test
    fun `extension availability is evaluated without throwing`() {
        val testExt = DecxExtensions.all.first { it.id == "test-ext" }
        assertThat(runCatching { testExt.isAvailable() }.isSuccess).isTrue()
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
    fun `extension route is resolvable by path`() {
        assertThat(DecxExtensions.routeOf("/api/decx/test-ext/ping")).isNotNull()
    }

    @Test
    fun `unknown extension path resolves to null`() {
        assertThat(DecxExtensions.routeOf("/api/decx/test-ext/does_not_exist")).isNull()
    }
}
