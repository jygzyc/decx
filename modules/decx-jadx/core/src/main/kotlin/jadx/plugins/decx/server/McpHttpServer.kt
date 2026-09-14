package jadx.plugins.decx.server

import com.google.gson.Gson
import io.ktor.server.cio.CIO
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.server.ServerOptions
import io.modelcontextprotocol.kotlin.sdk.server.mcpStatelessStreamableHttp
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.ServerCapabilities
import io.modelcontextprotocol.kotlin.sdk.types.TextContent
import io.modelcontextprotocol.kotlin.sdk.types.ToolSchema
import jadx.plugins.decx.DecxConstants
import jadx.plugins.decx.api.DecxApi
import jadx.plugins.decx.utils.LogUtils
import jadx.plugins.decx.utils.PluginUtils
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonElement as KxJsonElement
import kotlinx.serialization.json.JsonObject as KxJsonObject
import kotlinx.serialization.json.JsonArray as KxJsonArray
import kotlinx.serialization.json.JsonPrimitive as KxJsonPrimitive

/**
 * MCP server backed by the Kotlin SDK.
 *
 * This is the single MCP transport implementation for DECX. It exposes the
 * route-backed tools from [McpToolRegistry] over stateless Streamable HTTP at /mcp.
 *
 * Uses Ktor CIO (`embeddedServer`) because the MCP Kotlin SDK
 * (`mcpStatelessStreamableHttp`) is a Ktor plugin — it must be installed into a Ktor
 * server engine to accept HTTP connections. No other transport or server
 * framework is used here.
 */
class McpHttpServer(
    private val api: DecxApi,
    private val decxPort: Int,
    private val mcpPort: Int
) {
    private val gson = Gson()
    private val routeHandler = RouteHandler(api)
    private var engine: EmbeddedServer<*, *>? = null

    fun start(): Boolean {
        return try {
            val mcpServer = buildServer()
            engine = embeddedServer(CIO, host = "127.0.0.1", port = mcpPort) {
                mcpStatelessStreamableHttp(path = "/mcp") { mcpServer }
            }.start(wait = false)
            LogUtils.info("[MCP] Kotlin SDK MCP server started on port $mcpPort")
            true
        } catch (e: Exception) {
            LogUtils.warn("[MCP] Kotlin SDK MCP server start failed: ${e.message}")
            engine = null
            false
        }
    }

    fun stop() {
        engine?.stop(1000, 3000)
        engine = null
        LogUtils.info("[MCP] Kotlin SDK MCP server stopped")
    }

    private fun buildServer(): Server {
        val server = Server(
            serverInfo = Implementation(
                name = "DECX MCP Server",
                version = DecxConstants.getVersion()
            ),
            options = ServerOptions(
                capabilities = ServerCapabilities(
                    tools = ServerCapabilities.Tools(listChanged = false)
                )
            )
        )

        McpToolRegistry.tools.forEach { tool ->
            server.addTool(
                name = tool.name,
                description = tool.description,
                inputSchema = ToolSchema(
                    properties = toKotlinxJsonObject(tool.inputSchema["properties"]),
                    required = (tool.inputSchema["required"] as? List<*>)?.map { it.toString() } ?: emptyList()
                )
            ) { request ->
                val result = try {
                    val arguments = request.params.arguments?.entries
                        ?.associate { it.key to kxJsonToAny(it.value) }
                        ?: emptyMap()
                    executeTool(tool, arguments.mapValues { it.value ?: "" })
                } catch (e: Exception) {
                    LogUtils.warn("[MCP] Tool '${tool.name}' failed: ${e.message}")
                    linkedMapOf(
                        "ok" to false,
                        "tool" to tool.name,
                        "error" to (e.message ?: "Tool execution failed")
                    )
                }
                CallToolResult(
                    content = listOf(TextContent(gson.toJson(result))),
                    isError = result["ok"] == false
                )
            }
        }

        return server
    }

    private fun executeTool(tool: McpTool, arguments: Map<String, Any>): Map<String, Any> {
        return if (tool.routePath == "__health__") {
            linkedMapOf(
                "ok" to true,
                "status" to "running",
                "version" to DecxConstants.getVersion(),
                "url" to PluginUtils.buildServerUrl(port = decxPort),
                "port" to decxPort,
                "mcp_port" to mcpPort,
                "implementation" to "official-sdk",
                "timestamp" to System.currentTimeMillis()
            )
        } else {
            val payload = try {
                tool.toPayload(arguments)
            } catch (e: IllegalArgumentException) {
                return linkedMapOf(
                    "ok" to false,
                    "error" to "bad argument: ${e.message}",
                    "hint" to "Expected parameters: ${tool.inputSchema["required"]}"
                )
            }
            val page = payload["page"] as? Int ?: 1
            routeHandler.handle(tool.routePath, payload, page)
        }
    }

    // ---- Gson-based JSON helpers ----

    private val kotlinxJson = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

    private fun toKotlinxJsonObject(value: Any?): kotlinx.serialization.json.JsonObject {
        if (value == null) return buildJsonObject { }
        val jsonStr = gson.toJson(value)
        return kotlinxJson.parseToJsonElement(jsonStr).let {
            it as? kotlinx.serialization.json.JsonObject ?: buildJsonObject { }
        }
    }

    private fun kxJsonToAny(element: KxJsonElement): Any? {
        return when {
            element is KxJsonObject -> element.entries.associate { it.key to kxJsonToAny(it.value) }
            element is KxJsonArray -> element.map { kxJsonToAny(it) }
            element is KxJsonPrimitive -> when {
                element.isString -> element.content
                element.content == "true" -> true
                element.content == "false" -> false
                element.content.toIntOrNull() != null -> element.content.toInt()
                element.content.toDoubleOrNull() != null -> element.content.toDouble()
                else -> element.content
            }
            else -> element.toString()
        }
    }

}
