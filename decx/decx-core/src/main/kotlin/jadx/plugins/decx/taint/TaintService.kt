package jadx.plugins.decx.taint

import com.google.gson.Gson
import com.google.gson.JsonObject
import jadx.plugins.decx.taint.config.TaintConfig
import jadx.plugins.decx.taint.config.TaintConfigParser
import jadx.plugins.decx.taint.config.TargetConfig
import jadx.plugins.decx.taint.protocol.TaintFlowDto
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.LogUtils
import java.io.File

/**
 * Taint engine facade used by routes and MCP tools.
 *
 * Resolves targets (session -> apk path), hands work to the worker pool, and
 * shapes results into the standard DECX envelope ({@link AnalysisResultUtils}).
 */
class TaintService(
    private val env: TaintEnvironment,
    private val pool: TaintWorkerPool
) {

    companion object {
        const val KIND_ANALYZE = "taint_analyze"
        const val KIND_STATUS = "taint_status"
        const val KIND_CAPABILITIES = "taint_capabilities"
        const val KIND_TEMPLATES = "taint_templates"

        const val CODE_INVALID_CONFIG = "INVALID_TAINT_CONFIG"
        const val CODE_ANALYSIS_FAILED = "TAINT_ANALYSIS_FAILED"
        const val CODE_NOT_READY = "TAINT_ENGINE_NOT_READY"

        private val gson = Gson()
    }

    // ------------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------------

    fun status(): Map<String, Any> =
        AnalysisResultUtils.success(
            kind = KIND_STATUS,
            items = listOf(env.status())
        )

    fun capabilities(): Map<String, Any> =
        AnalysisResultUtils.success(
            kind = KIND_CAPABILITIES,
            items = listOf(
                linkedMapOf<String, Any>(
                    "engines" to listOf(
                        linkedMapOf(
                            "id" to "taie",
                            "version" to "0.5.4",
                            "description" to "Tai-e pointer analysis + taint (PacDroid Android modeling)",
                            "algorithms" to listOf("pta"),
                            "contextSensitivities" to listOf("ci", "1obj", "2obj", "2-type", "2obj+H"),
                            "scopes" to listOf("APP", "REACHABLE"),
                            "presets" to TaintConfigParser.listPresets()
                        )
                    ),
                    "limits" to linkedMapOf(
                        "timeoutSec" to "Hard wall-clock timeout for the whole analysis.",
                        "maxPointerAnalyzeTimeSec" to "Per-analysis Tai-e time-limit (seconds)."
                    )
                )
            )
        )

    fun templates(): Map<String, Any> =
        AnalysisResultUtils.success(
            kind = KIND_TEMPLATES,
            items = TaintConfigParser.listPresets()
        )

    /**
     * Run a taint analysis. Blocks until the worker finishes.
     *
     * @param config resolved taint config
     * @param onProgress optional progress callback (stage, message)
     * @return a success envelope with flows as items, or a failure envelope
     */
    fun analyze(config: TaintConfig, onProgress: (String, String) -> Unit = { _, _ -> }): Map<String, Any> {
        if (!env.isReady()) {
            val missing = env.status().filterValues { it == false || it == emptyList<Any>() }.keys
            return AnalysisResultUtils.error(
                kind = KIND_ANALYZE,
                code = CODE_NOT_READY,
                message = "Taint engine not ready (missing: $missing). " +
                    "Install with 'decx self install tai-e'."
            )
        }
        val apk = try {
            resolveApk(config.target)
        } catch (e: IllegalArgumentException) {
            return AnalysisResultUtils.error(KIND_ANALYZE, code = CODE_INVALID_CONFIG, message = e.message ?: "bad target")
        }

        val platforms = env.platformsDir(config.target.platforms)
        if (config.target.session == null && platforms == null) {
            return AnalysisResultUtils.error(
                KIND_ANALYZE,
                code = CODE_NOT_READY,
                message = "No Android platforms found (expected DECX_HOME/platforms or target.platforms)"
            )
        }

        val request = AnalyzeRequest(
            id = System.currentTimeMillis(),
            apk = apk,
            platforms = platforms?.absolutePath,
            config = config
        )
        return try {
            val outcome = pool.analyze(request, onProgress)
            toSuccessEnvelope(outcome.flows, outcome.meta)
        } catch (e: TaintException) {
            LogUtils.warn("[taint] ${e.message}")
            AnalysisResultUtils.error(KIND_ANALYZE, code = CODE_ANALYSIS_FAILED, message = e.message ?: "analysis failed")
        } catch (e: Exception) {
            LogUtils.error(jadx.plugins.decx.api.DecxError.SERVER_INTERNAL_ERROR, e, "[taint] unexpected failure")
            AnalysisResultUtils.error(
                KIND_ANALYZE,
                code = CODE_ANALYSIS_FAILED,
                message = "Unexpected failure: ${e.message}"
            )
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private fun resolveApk(target: TargetConfig): String {
        target.apk?.let { return it }
        val session = target.session ?: throw IllegalArgumentException("target: session or apk required")
        val sessionFile = File(env.decxHome, "sessions/$session.json")
        if (!sessionFile.isFile) {
            throw IllegalArgumentException("Session '$session' not found in ${sessionFile.parent}")
        }
        return try {
            val json: JsonObject = gson.fromJson(sessionFile.readText(), JsonObject::class.java)
            json.get("path")?.asString
                ?: throw IllegalArgumentException("Session '$session' has no target path")
        } catch (e: com.google.gson.JsonParseException) {
            throw IllegalArgumentException("Session file corrupt: ${sessionFile.name}", e)
        }
    }

    private fun toSuccessEnvelope(flows: List<TaintFlowDto>, meta: Map<String, Any>): Map<String, Any> {
        val items = flows.mapIndexed { index, f ->
            AnalysisResultUtils.item(
                id = "flow-${index + 1}",
                kind = "taint_flow",
                title = "${f.sourceMethod} -> ${f.sinkMethod}",
                content = "${f.source}\n  ->\n${f.sink}",
                meta = linkedMapOf(
                    "source" to f.source,
                    "sink" to f.sink,
                    "source_method" to f.sourceMethod,
                    "sink_method" to f.sinkMethod,
                    "source_line" to (f.sourceLine ?: 0),
                    "sink_line" to (f.sinkLine ?: 0)
                )
            )
        }
        return AnalysisResultUtils.success(
            kind = KIND_ANALYZE,
            query = mapOf("flows" to flows.size),
            items = items,
            summary = meta
        )
    }
}
