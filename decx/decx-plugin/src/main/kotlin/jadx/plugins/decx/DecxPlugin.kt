package jadx.plugins.decx

import jadx.api.plugins.JadxPlugin
import jadx.api.plugins.JadxPluginContext
import jadx.api.plugins.JadxPluginInfo
import jadx.api.plugins.JadxPluginInfoBuilder
import jadx.plugins.decx.server.DecxServer
import jadx.plugins.decx.lifecycle.PluginLifecycleManager
import jadx.plugins.decx.api.DecxError
import jadx.plugins.decx.ui.DecxUIManager
import jadx.plugins.decx.server.DecxMcpServer
import jadx.plugins.decx.utils.CacheUtils
import jadx.plugins.decx.utils.LogUtils
import jadx.plugins.decx.utils.PreferencesManager

class DecxPlugin : JadxPlugin {

    companion object {
        const val PLUGIN_NAME = "Decx"
        const val PLUGIN_ID = "jadx-decx-plugin"
    }

    private var server: DecxServer? = null
    private var mcpServer: DecxMcpServer? = null

    override fun init(ctx: JadxPluginContext) {
        try {
            PluginLifecycleManager(ctx) { srv, api ->
                this.server = srv
                val mcp = DecxMcpServer(PreferencesManager.getPort(), api)
                srv.mcpServer = mcp
                this.mcpServer = mcp

                ctx.guiContext?.let { guiContext ->
                    DecxUIManager(ctx, srv, mcp).initializeGuiComponents(guiContext)
                }

                if (PreferencesManager.getMcpAutoStart()) {
                    Thread({
                        try {
                            mcp.start()
                        } catch (e: Exception) {
                            LogUtils.warn("[MCP] Auto-start failed: ${e.message}")
                        }
                    }, "Decx-MCP-AutoStart").apply { isDaemon = true }.start()
                }
            }.start()

        } catch (e: Exception) {
            LogUtils.error(DecxError.SERVER_INTERNAL_ERROR, "Failed to initialize plugin", e)
            cleanupOnError()
            throw e
        }
    }

    override fun getPluginInfo(): JadxPluginInfo? {
        return JadxPluginInfoBuilder.pluginId(PLUGIN_ID)
            .name(PLUGIN_NAME)
            .description("Decompiler + X - Bridges JADX with AI assistants via CLI and MCP, Powerful support with skills")
            .homepage("https://github.com/jygzyc/decx")
            .requiredJadxVersion("1.5.2, r2472")
            .build()
    }

    override fun unload() {
        try {
            LogUtils.info("Cleaning up Decx plugin resources...")
            CacheUtils.clearCache()
            server?.stop()
            PreferencesManager.clearCache()
        } catch (e: Exception) {
            LogUtils.error(DecxError.SERVER_INTERNAL_ERROR, "Error during plugin unload", e)
        }
    }

    private fun cleanupOnError() {
        server?.stop()
    }
}
