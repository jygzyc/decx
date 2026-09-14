package jadx.plugins.decx.utils

import java.net.InetSocketAddress
import java.net.Socket

object PluginUtils {

    private const val LOCALHOST = "127.0.0.1"
    private const val IP_DISCOVERY_HOST = "8.8.8.8"
    private const val IP_DISCOVERY_PORT = 53
    private const val IP_DISCOVERY_TIMEOUT_MS = 1000

    private fun getLocalIpAddress(): String {
        return runCatching {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(IP_DISCOVERY_HOST, IP_DISCOVERY_PORT), IP_DISCOVERY_TIMEOUT_MS)
                socket.localAddress.hostAddress ?: LOCALHOST
            }
        }.getOrDefault(LOCALHOST)
    }

    fun buildServerUrl(
        ipAddress: String = getLocalIpAddress(),
        port: Int,
        running: Boolean = true
    ): String {
        if (port !in 1..65535) {
            throw IllegalArgumentException("Port must be between 1 and 65535, got: $port")
        }
        return if (running) "http://$ipAddress:$port" else "N/A"
    }
}
