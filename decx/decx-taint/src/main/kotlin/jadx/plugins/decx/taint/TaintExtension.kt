package jadx.plugins.decx.taint

import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxRoute
import jadx.plugins.decx.api.DecxRouteGroup
import jadx.plugins.decx.extension.DecxExtension
import jadx.plugins.decx.server.McpTool

/**
 * DECX taint-analysis extension: three outward-facing interfaces over the
 * Tai-e worker engine.
 *
 *   /api/decx/taint/config    (taint_config)    — rules + capabilities + environment
 *   /api/decx/taint/analyze   (taint_analyze)   — validate + enqueue async analysis
 *   /api/decx/taint/progress  (taint_progress)  — job state/log/results (cancel via flag)
 *
 * Availability is driven by [TaintEnvironment]: when the Tai-e jars, worker
 * jar, or JREs are missing, [isAvailable] is false, the routes are not
 * registered, and the core service is completely unaffected.
 */
class TaintExtension(private val env: TaintEnvironment = TaintEnvironment()) : DecxExtension {

    private val pool by lazy { TaintWorkerPool(env) }
    private val service by lazy {
        TaintService(env, pool, TaintJobManager(pool))
    }

    override val id: String = "taint"

    override fun isAvailable(): Boolean = env.isReady()

    override fun routeGroups(): List<DecxRouteGroup> = listOf(
        DecxRouteGroup(
            name = "taint",
            routes = listOf(configRoute, analyzeRoute, progressRoute)
        )
    )

    override fun mcpTools(): List<McpTool> = listOf(
        McpTool(
            name = "taint_config",
            description = "Inspect taint analysis rules and engine state. With no input: built-in rules + engine " +
                "capabilities + environment. With rules (inline JSON), rulePath (directory), or ruleNames: " +
                "parse/validate and return per-rule summaries (severity, category, entry counts).",
            inputSchema = schema(
                properties = linkedMapOf(
                    "rules" to stringProp("Inline rule document JSON: {\"ruleName\": {sources, sinks, transfers, sanitizers, ...}}"),
                    "rulePath" to stringProp("Directory containing *.json rule files"),
                    "ruleNames" to stringProp("Comma-separated rule names to select/filter")
                )
            ),
            routePath = PATH_CONFIG,
            toPayload = { it }
        ),
        McpTool(
            name = "taint_analyze",
            description = "Start an async taint analysis over an APK (or an open DECX session) and return {jobId}. " +
                "Poll taint_progress with the jobId for state, progress log, and attributed flows.",
            inputSchema = schema(
                properties = linkedMapOf(
                    "target" to objectProp("Target: {session: name} or {apk: /path/app.apk} (+ optional platforms dir)"),
                    "rules" to stringProp("Inline rule document JSON (same format as taint_config)"),
                    "rulePath" to stringProp("Directory containing *.json rule files"),
                    "ruleNames" to stringProp("Comma-separated rule names to run (defaults to all built-in rules)"),
                    "analysis" to objectProp("Analysis tuning: {contextSensitivity: ci|1obj|2obj|2-type|2obj+H, scope: APP|REACHABLE, distinguishStrings: bool}"),
                    "limits" to objectProp("Limits: {timeoutSec: int, maxPointerAnalyzeTimeSec: int}")
                ),
                required = listOf("target")
            ),
            routePath = PATH_ANALYZE,
            toPayload = { it }
        ),
        McpTool(
            name = "taint_progress",
            description = "Get taint job progress/results. With jobId: state, stage, progressLog, and — when " +
                "succeeded — attributed taint flows (rule names, severity, source/sink methods and lines). " +
                "Without jobId: list recent jobs. Set cancel=true to cancel a queued/running job.",
            inputSchema = schema(
                properties = linkedMapOf(
                    "jobId" to stringProp("Job id returned by taint_analyze"),
                    "cancel" to linkedMapOf(
                        "type" to "boolean",
                        "description" to "When true, cancel the referenced queued/running job"
                    )
                )
            ),
            routePath = PATH_PROGRESS,
            toPayload = { it }
        )
    )

    // ------------------------------------------------------------------
    // Routes
    // ------------------------------------------------------------------

    private val configRoute = DecxRoute(PATH_CONFIG, TaintService.KIND_CONFIG) { _, params ->
        envelope(service.loadConfig(params.raw()))
    }

    private val analyzeRoute = DecxRoute(PATH_ANALYZE, TaintService.KIND_ANALYZE) { _, params ->
        envelope(service.startAnalysis(params.raw()))
    }

    private val progressRoute = DecxRoute(PATH_PROGRESS, TaintService.KIND_PROGRESS) { _, params ->
        envelope(service.getProgress(params.raw()))
    }

    private fun envelope(body: Map<String, Any>): DecxApiResult =
        if (body["ok"] == true) DecxApiResult.ok(body) else DecxApiResult.fail(body)

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

    private fun stringProp(description: String): Map<String, Any> = linkedMapOf(
        "type" to "string",
        "description" to description
    )

    private fun objectProp(description: String): Map<String, Any> = linkedMapOf(
        "type" to "object",
        "description" to description
    )

    companion object {
        const val PATH_CONFIG = "/api/decx/taint/config"
        const val PATH_ANALYZE = "/api/decx/taint/analyze"
        const val PATH_PROGRESS = "/api/decx/taint/progress"
    }
}
