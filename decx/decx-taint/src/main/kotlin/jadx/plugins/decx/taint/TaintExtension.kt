package jadx.plugins.decx.taint

import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxRoute
import jadx.plugins.decx.api.DecxRouteGroup
import jadx.plugins.decx.extension.DecxExtension
import jadx.plugins.decx.server.McpTool
import jadx.plugins.decx.taint.config.TaintConfigParser

/**
 * DECX taint-analysis extension.
 *
 * Mounts an independent Tai-e-powered taint engine under the
 * /api/decx/taint path prefix without touching the core jadx-backed routes. The engine runs in a separate
 * worker process (see [TaintWorkerPool]); this class only owns route/MCP
 * registration and orchestrates through [TaintService].
 *
 * Availability is driven by [TaintEnvironment]: when the worker jar, Tai-e
 * modified jars, or JREs are missing, [isAvailable] is false, the routes are
 * not registered, and the core service is completely unaffected.
 */
class TaintExtension(private val env: TaintEnvironment = TaintEnvironment()) : DecxExtension {

    private val pool by lazy { TaintWorkerPool(env) }
    private val service by lazy { TaintService(env, pool) }

    override val id: String = "taint"

    override fun isAvailable(): Boolean = env.isReady()

    override fun routeGroups(): List<DecxRouteGroup> = listOf(
        DecxRouteGroup(
            name = "taint",
            routes = listOf(statusRoute, analyzeRoute, capabilitiesRoute, templatesRoute)
        )
    )

    override fun mcpTools(): List<McpTool> = listOf(
        McpTool(
            name = "taint_status",
            description = "Report taint engine readiness: worker jar, Tai-e modified jars, JREs, Android platforms.",
            inputSchema = schema(),
            routePath = TaintService.KIND_STATUS.let { "/api/decx/taint/status" },
            toPayload = { emptyMap() }
        ),
        McpTool(
            name = "taint_analyze",
            description = "Run a taint analysis over an APK (or an open DECX session) using the Tai-e worker. " +
                "Accepts a YAML config with preset inheritance, field-level overrides, and a raw escape hatch.",
            inputSchema = schema(
                properties = linkedMapOf(
                    "config" to linkedMapOf(
                        "type" to "string",
                        "description" to "YAML taint config. Example: preset: privacy-leak / target: { session: sieve } " +
                            "/ analysis: { contextSensitivity: 2obj } / limits: { timeoutSec: 600 } / taint: { sources: [...], sinks: [...] } / raw: { pta: {...} }"
                    )
                ),
                required = listOf("config")
            ),
            routePath = "/api/decx/taint/analyze",
            toPayload = { args ->
                val config = args["config"]?.toString()?.trim()
                    ?: throw IllegalArgumentException("Missing required parameter: config")
                linkedMapOf("config" to config)
            }
        ),
        McpTool(
            name = "taint_capabilities",
            description = "List taint engine capabilities: supported algorithms, context sensitivities, scopes, and built-in presets.",
            inputSchema = schema(),
            routePath = "/api/decx/taint/capabilities",
            toPayload = { emptyMap() }
        ),
        McpTool(
            name = "taint_templates",
            description = "List built-in taint preset templates (privacy-leak, quick-scan, ...).",
            inputSchema = schema(),
            routePath = "/api/decx/taint/templates",
            toPayload = { emptyMap() }
        )
    )

    // ------------------------------------------------------------------
    // Routes
    // ------------------------------------------------------------------

    private val statusRoute = DecxRoute("/api/decx/taint/status", TaintService.KIND_STATUS) { _, _ ->
        DecxApiResult.ok(service.status())
    }

    private val analyzeRoute = DecxRoute("/api/decx/taint/analyze", TaintService.KIND_ANALYZE) { _, params ->
        val configYaml = params.string("config")
        val config = try {
            TaintConfigParser.resolve(configYaml)
        } catch (e: IllegalArgumentException) {
            return@DecxRoute DecxApiResult.error(
                kind = TaintService.KIND_ANALYZE,
                code = TaintService.CODE_INVALID_CONFIG,
                message = e.message ?: "invalid taint config"
            )
        }
        val result = service.analyze(config)
        if (result["ok"] == true) DecxApiResult.ok(result) else DecxApiResult.fail(result)
    }

    private val capabilitiesRoute =
        DecxRoute("/api/decx/taint/capabilities", TaintService.KIND_CAPABILITIES) { _, _ ->
            DecxApiResult.ok(service.capabilities())
        }

    private val templatesRoute =
        DecxRoute("/api/decx/taint/templates", TaintService.KIND_TEMPLATES) { _, _ ->
            DecxApiResult.ok(service.templates())
        }

    // ------------------------------------------------------------------
    // MCP schema helpers
    // ------------------------------------------------------------------

    private fun schema(
        properties: Map<String, Map<String, Any>> = emptyMap(),
        required: List<String> = emptyList()
    ): Map<String, Any> = linkedMapOf(
        "type" to "object",
        "properties" to properties,
        "required" to required
    )
}
