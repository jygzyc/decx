package jadx.plugins.decx.extension

import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxRoute
import jadx.plugins.decx.api.DecxRouteGroup

/**
 * Minimal DecxExtension used by the SPI registry tests. Registered in
 * `src/test/resources/META-INF/services` so [DecxExtensionsTest] can verify
 * ServiceLoader discovery without depending on a real extension module.
 */
class TestExtension : DecxExtension {

    override val id: String = "test-ext"

    override fun isAvailable(): Boolean = true

    override fun routeGroups(): List<DecxRouteGroup> = listOf(
        DecxRouteGroup(
            name = "test-ext",
            routes = listOf(
                DecxRoute("/api/decx/test-ext/ping", "test_ext_ping") { _, _ ->
                    DecxApiResult.ok(mapOf("pong" to true))
                }
            )
        )
    )
}
