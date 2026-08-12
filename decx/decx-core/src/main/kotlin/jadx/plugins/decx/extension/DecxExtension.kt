package jadx.plugins.decx.extension

import jadx.plugins.decx.api.DecxRouteGroup
import jadx.plugins.decx.server.McpTool

/**
 * SPI for mounting additional analysis capabilities onto a running DECX server
 * without touching the core jadx-backed surface.
 *
 * Extensions are discovered via [java.util.ServiceLoader]: implementations
 * register themselves in
 * `META-INF/services/jadx.plugins.decx.extension.DecxExtension`.
 *
 * Contract:
 *  - [isAvailable] gates registration. When `false`, the extension contributes
 *    no routes and no MCP tools, so a missing optional environment (e.g. the
 *    Tai-e worker + JREs) cannot degrade the core service.
 *  - Routes reuse the same [DecxRouteGroup] / DecxRoute shape as the built-in
 *    jadx routes, so [jadx.plugins.decx.server.RouteHandler] dispatches them
 *    uniformly.
 *  - [mcpTools] reuse the same [McpTool] shape and map onto the extension's
 *    own routes via `routePath`.
 *
 * Implementations must be safe to construct and query on the server's startup
 * thread; heavy initialization belongs in the worker, not here.
 */
interface DecxExtension {
    /** Stable unique id, e.g. "taint". Used for logging and status reporting. */
    val id: String

    /** Whether the extension's environment is ready to serve requests. */
    fun isAvailable(): Boolean

    /** Route groups contributed by this extension. */
    fun routeGroups(): List<DecxRouteGroup>

    /** MCP tools contributed by this extension (default: none). */
    fun mcpTools(): List<McpTool> = emptyList()
}
