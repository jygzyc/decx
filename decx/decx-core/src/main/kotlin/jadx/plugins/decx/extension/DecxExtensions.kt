package jadx.plugins.decx.extension

import jadx.plugins.decx.api.DecxRoute
import jadx.plugins.decx.api.DecxRouteGroup
import jadx.plugins.decx.server.McpTool
import jadx.plugins.decx.utils.LogUtils
import java.util.ServiceLoader

/**
 * Registry of all [DecxExtension]s discovered on the classpath.
 *
 * Loaded once via [ServiceLoader]; availability is evaluated lazily so an
 * extension whose environment is missing is simply silent rather than fatal.
 */
object DecxExtensions {

    private const val UNKNOWN = "unknown"

    private val loaded: List<DecxExtension> by lazy { loadSafely() }

    private val available: List<DecxExtension> by lazy {
        loaded.filter { ext ->
            runCatching { ext.isAvailable() }
                .onFailure { LogUtils.warn("Extension '${ext.id}' availability check failed: ${it.message}") }
                .getOrDefault(false)
        }
    }

    /** All extensions that loaded, regardless of availability (for status UI). */
    val all: List<DecxExtension> get() = loaded

    /** Extensions whose environment is ready and thus contribute routes/tools. */
    val active: List<DecxExtension> get() = available

    val routeGroups: List<DecxRouteGroup>
        get() = available.flatMap { runCatching { it.routeGroups() }.getOrDefault(emptyList()) }

    val routes: List<DecxRoute>
        get() = routeGroups.flatMap { it.routes }

    val mcpTools: List<McpTool>
        get() = available.flatMap { runCatching { it.mcpTools() }.getOrDefault(emptyList()) }

    private val routesByPath: Map<String, DecxRoute> by lazy { routes.associateBy { it.path } }
    private val kindByPath: Map<String, String> by lazy { routes.associate { it.path to it.kind } }

    fun routeOf(path: String): DecxRoute? = routesByPath[path]

    fun kindOf(path: String): String? = kindByPath[path]

    /** Status snapshot for the health endpoint. */
    fun status(): List<Map<String, Any>> = loaded.map { ext ->
        linkedMapOf<String, Any>(
            "id" to ext.id,
            "available" to runCatching { ext.isAvailable() }.getOrDefault(false),
            "routes" to runCatching { ext.routeGroups().sumOf { it.routes.size } }.getOrDefault(0)
        )
    }

    private fun loadSafely(): List<DecxExtension> = try {
        ServiceLoader.load(DecxExtension::class.java).toList()
    } catch (e: Throwable) {
        LogUtils.warn("Failed to load DecxExtensions: ${e.message}")
        emptyList()
    }
}
