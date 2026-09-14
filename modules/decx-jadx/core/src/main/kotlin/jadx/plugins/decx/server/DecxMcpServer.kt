package jadx.plugins.decx.server

import jadx.plugins.decx.api.DecxApi
import jadx.plugins.decx.utils.LogUtils
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Core MCP server lifecycle API.
 *
 * Plugin and standalone callers should use this class instead of owning MCP
 * transport details. MCP runs in-process using the Kotlin SDK on
 * DECX HTTP port + 1.
 */
class DecxMcpServer(
    private var decxPort: Int,
    private val api: DecxApi
) {
    private var server: McpHttpServer? = null
    private val running = AtomicBoolean(false)

    val mcpPort: Int get() = decxPort + 1
    fun mcpUrl(): String = "http://127.0.0.1:$mcpPort/mcp"
    fun isRunning(): Boolean = running.get()

    @Synchronized
    fun updatePort(newPort: Int) {
        decxPort = newPort
    }

    @Synchronized
    fun start(): Boolean {
        if (isRunning()) {
            LogUtils.info("[MCP] Server is already running")
            return true
        }
        if (isPortInUse(mcpPort)) {
            LogUtils.warn("[MCP] Port $mcpPort is already in use")
            return false
        }

        val instance = McpHttpServer(api, decxPort, mcpPort)
        val started = instance.start()
        if (started) {
            server = instance
            running.set(true)
            LogUtils.info("[MCP] Server started (Port: $mcpPort)")
        }
        return started
    }

    @Synchronized
    fun stop() {
        if (!isRunning()) return
        try {
            LogUtils.info("[MCP] Stopping server...")
            server?.stop()
        } catch (e: Exception) {
            LogUtils.warn("[MCP] Stop failed: ${e.message}")
        } finally {
            server = null
            running.set(false)
            LogUtils.info("[MCP] Server stopped")
        }
    }

    private fun isPortInUse(port: Int): Boolean {
        return try {
            Socket("127.0.0.1", port).use { true }
        } catch (_: Exception) {
            false
        }
    }
}
