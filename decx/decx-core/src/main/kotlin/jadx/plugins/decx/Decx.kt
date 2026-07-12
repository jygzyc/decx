package jadx.plugins.decx

import jadx.api.JadxDecompiler
import jadx.plugins.decx.api.DecxApi
import jadx.plugins.decx.api.DecxApiImpl
import jadx.plugins.decx.api.DecxRoute
import jadx.plugins.decx.api.DecxRouteGroup
import jadx.plugins.decx.api.DecxRoutes
import jadx.plugins.decx.server.DecxServer
import jadx.plugins.decx.server.DecxMcpServer
import jadx.plugins.decx.server.McpTool
import jadx.plugins.decx.server.McpToolRegistry
import jadx.plugins.decx.service.ITaiEEngine
import jadx.plugins.decx.service.UiBackedService

/**
 * Public DECX core entry point for embedders.
 *
 * Use this facade instead of depending on implementation classes directly when
 * wiring DECX into a plugin, standalone server, or another JVM host.
 */
object Decx {
    fun api(
        decompiler: JadxDecompiler,
        cacheEnabled: Boolean = true,
        uiService: UiBackedService? = null,
        taiEEngine: ITaiEEngine? = null
    ): DecxApi = DecxApiImpl(decompiler, cacheEnabled, uiService, taiEEngine)

    fun httpServer(api: DecxApi, port: Int = DecxConstants.DEFAULT_PORT): DecxServer =
        DecxServer(api, port)

    fun mcpServer(api: DecxApi, decxPort: Int = DecxConstants.DEFAULT_PORT): DecxMcpServer =
        DecxMcpServer(decxPort, api)

    val routeGroups: List<DecxRouteGroup>
        get() = DecxRoutes.groups

    val routes: List<DecxRoute>
        get() = DecxRoutes.all

    val mcpTools: List<McpTool>
        get() = McpToolRegistry.tools
}
