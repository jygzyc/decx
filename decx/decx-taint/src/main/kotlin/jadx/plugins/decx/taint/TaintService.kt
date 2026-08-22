package jadx.plugins.decx.taint

import com.google.gson.Gson
import com.google.gson.JsonObject
import jadx.plugins.decx.taint.config.TaintConfig
import jadx.plugins.decx.taint.config.TaintConfigParser
import jadx.plugins.decx.taint.protocol.TaintFlowDto
import jadx.plugins.decx.taint.rules.TaintRule
import jadx.plugins.decx.taint.rules.TaintRuleCompiler
import jadx.plugins.decx.taint.rules.TaintRuleParser
import jadx.plugins.decx.utils.AnalysisResultUtils
import java.io.File

/**
 * Taint engine facade: the three outward-facing operations.
 *
 *  - [loadConfig]     — rule/config inspection and validation
 *  - [startAnalysis]  — validate, enqueue, return a job id (async)
 *  - [getProgress]    — job state, progress log, and (when done) attributed results
 *
 * All methods return the standard DECX envelope ([AnalysisResultUtils]).
 */
class TaintService(
    private val env: TaintEnvironment,
    private val pool: TaintWorkerPool,
    private val jobs: TaintJobManager
) {

    companion object {
        const val KIND_CONFIG = "taint_config"
        const val KIND_ANALYZE = "taint_analyze"
        const val KIND_PROGRESS = "taint_progress"

        const val ITEM_KIND_FLOW = "taint_flow"
        const val ITEM_KIND_JOB = "taint_job"
        const val ITEM_KIND_RULE = "taint_rule"

        const val CODE_INVALID_CONFIG = "INVALID_TAINT_CONFIG"
        const val CODE_ANALYSIS_FAILED = "TAINT_ANALYSIS_FAILED"
        const val CODE_NOT_READY = "TAINT_ENGINE_NOT_READY"
        const val CODE_JOB_NOT_FOUND = "TAINT_JOB_NOT_FOUND"
        const val CODE_QUEUE_FULL = "TAINT_QUEUE_FULL"

        private val SEVERITY_ORDER = listOf(
            TaintRule.SEVERITY_INFO, TaintRule.SEVERITY_LOW, TaintRule.SEVERITY_MEDIUM,
            TaintRule.SEVERITY_HIGH, TaintRule.SEVERITY_CRITICAL
        )
        private val gson = Gson()
    }

    // ------------------------------------------------------------------
    // 1. Config: rule listing + validation
    // ------------------------------------------------------------------

    /**
     * With no rule input: lists built-in rules plus engine capabilities and
     * environment status. With `rules` (inline JSON) / `rulePath` (directory)
     * and optional `ruleNames`: parses, validates, and returns per-rule
     * summaries.
     */
    fun loadConfig(payload: Map<String, Any>): Map<String, Any> {
        val query = linkedMapOf<String, Any>()
        val rules = try {
            resolveRules(payload, query)
        } catch (e: IllegalArgumentException) {
            return AnalysisResultUtils.error(KIND_CONFIG, query, CODE_INVALID_CONFIG, e.message ?: "invalid rules")
        }
        val ruleItems = rules.map { ruleItem(it) }
        return AnalysisResultUtils.success(
            kind = KIND_CONFIG,
            query = query,
            items = listOf(engineItem(), environmentItem()) + ruleItems,
            summary = linkedMapOf(
                "ruleCount" to rules.size,
                "ready" to env.isReady()
            )
        )
    }

    // ------------------------------------------------------------------
    // 2. Analyze: validate + enqueue (async)
    // ------------------------------------------------------------------

    fun startAnalysis(payload: Map<String, Any>): Map<String, Any> {
        val query = linkedMapOf<String, Any>()
        if (!env.isReady()) {
            val status = env.status()
            val missing = status.filterValues { it == false || it == emptyList<Any>() }.keys
            return AnalysisResultUtils.error(
                KIND_ANALYZE, query, CODE_NOT_READY,
                "Taint engine not ready (missing: $missing). Install with 'decx self install tai-e'."
            )
        }
        val rules = try {
            resolveRules(payload, query)
        } catch (e: IllegalArgumentException) {
            return AnalysisResultUtils.error(KIND_ANALYZE, query, CODE_INVALID_CONFIG, e.message ?: "invalid rules")
        }
        val compiled = try {
            TaintRuleCompiler.compile(rules)
        } catch (e: IllegalArgumentException) {
            return AnalysisResultUtils.error(KIND_ANALYZE, query, CODE_INVALID_CONFIG, e.message ?: "invalid rules")
        }
        val config = try {
            TaintConfigParser.fromPayload(payload)
        } catch (e: IllegalArgumentException) {
            return AnalysisResultUtils.error(KIND_ANALYZE, query, CODE_INVALID_CONFIG, e.message ?: "invalid config")
        }
        val apk = try {
            resolveApk(config)
        } catch (e: IllegalArgumentException) {
            return AnalysisResultUtils.error(KIND_ANALYZE, query, CODE_INVALID_CONFIG, e.message ?: "bad target")
        }
        val platforms = env.platformsDir(config.target.platforms)
        if (config.target.session == null && platforms == null) {
            return AnalysisResultUtils.error(
                KIND_ANALYZE, query, CODE_NOT_READY,
                "No Android platforms found (expected DECX_HOME/platforms or target.platforms)"
            )
        }

        val request = AnalyzeRequest(
            id = pool.nextId(),
            apk = apk,
            platforms = platforms?.absolutePath,
            config = config,
            taintFragment = compiled.taintFragment
        )
        val jobId = try {
            jobs.submit(request, compiled)
        } catch (e: TaintException) {
            return AnalysisResultUtils.error(KIND_ANALYZE, query, CODE_QUEUE_FULL, e.message ?: "queue full")
        }
        query["jobId"] = jobId
        return AnalysisResultUtils.success(
            kind = KIND_ANALYZE,
            query = query,
            items = listOf(
                AnalysisResultUtils.item(
                    id = jobId,
                    kind = ITEM_KIND_JOB,
                    title = "queued",
                    meta = linkedMapOf(
                        "jobId" to jobId,
                        "state" to TaintJobManager.STATE_QUEUED,
                        "apk" to apk,
                        "ruleNames" to rules.map { it.name },
                        "timeoutSec" to config.limits.timeoutSec
                    )
                )
            ),
            summary = linkedMapOf(
                "jobId" to jobId,
                "state" to TaintJobManager.STATE_QUEUED,
                "ruleCount" to rules.size
            )
        )
    }

    // ------------------------------------------------------------------
    // 3. Progress: state, log, and results
    // ------------------------------------------------------------------

    /**
     * With `jobId`: one job's state/progress; when it succeeded, items are the
     * attributed taint flows. Without `jobId`: recent jobs (no flows).
     * `cancel: true` + `jobId` cancels a queued/running job first.
     */
    fun getProgress(payload: Map<String, Any>): Map<String, Any> {
        val jobId = (payload["jobId"] as? String)?.takeIf { it.isNotBlank() }
        if (jobId == null) {
            val list = jobs.list()
            return AnalysisResultUtils.success(
                kind = KIND_PROGRESS,
                items = list.map { jobItem(it) },
                summary = linkedMapOf("jobCount" to list.size)
            )
        }
        if (payload["cancel"] == true) {
            jobs.cancel(jobId)
        }
        val detail = jobs.detail(jobId)
            ?: return AnalysisResultUtils.error(KIND_PROGRESS, mapOf("jobId" to jobId), CODE_JOB_NOT_FOUND, "Unknown taint job: $jobId")

        val snapshot = detail.snapshot
        val state = snapshot["state"] as String
        if (state != TaintJobManager.STATE_SUCCEEDED || detail.compiled == null) {
            return AnalysisResultUtils.success(
                kind = KIND_PROGRESS,
                query = mapOf("jobId" to jobId),
                items = listOf(jobItem(snapshot)),
                summary = linkedMapOf("jobId" to jobId, "state" to state)
            )
        }
        val compiled = detail.compiled!!
        val flows = detail.flows
        val flowItems = flows.mapIndexed { index, flow ->
            val attribution = compiled.attribute(flow.sourceMethod, flow.sinkMethod)
            flowItem(index + 1, flow, attribution)
        }
        val perRule = linkedMapOf<String, Int>()
        flows.forEach { flow ->
            compiled.attribute(flow.sourceMethod, flow.sinkMethod).rules.forEach { rule ->
                perRule[rule.name] = (perRule[rule.name] ?: 0) + 1
            }
        }
        return AnalysisResultUtils.success(
            kind = KIND_PROGRESS,
            query = mapOf("jobId" to jobId),
            items = flowItems,
            summary = linkedMapOf(
                "jobId" to jobId,
                "state" to state,
                "elapsedMs" to (snapshot["elapsedMs"] ?: 0),
                "flowCount" to flows.size,
                "perRule" to perRule,
                "progressLog" to (snapshot["progressLog"] ?: emptyList<Any>())
            )
        )
    }

    // ------------------------------------------------------------------
    // Rule resolution
    // ------------------------------------------------------------------

    private fun resolveRules(payload: Map<String, Any>, query: MutableMap<String, Any>): List<TaintRule> {
        val inline = payload["rules"] as? String
        val rulePath = (payload["rulePath"] as? String)?.takeIf { it.isNotBlank() }
        val ruleNames = parseRuleNames(payload)
        if (ruleNames.isNotEmpty()) query["ruleNames"] = ruleNames

        val rules: List<TaintRule> = when {
            !inline.isNullOrBlank() -> {
                query["rules"] = "inline"
                TaintRuleParser.parseDocument(inline, TaintRule.ORIGIN_INLINE)
            }
            rulePath != null -> {
                query["rulePath"] = rulePath
                TaintRuleParser.loadDir(File(rulePath))
            }
            else -> TaintRuleParser.loadBuiltin()
        }
        return TaintRuleParser.select(rules, ruleNames)
    }

    private fun parseRuleNames(payload: Map<String, Any>): List<String> {
        return when (val raw = payload["ruleNames"]) {
            null -> emptyList()
            is List<*> -> raw.map { it.toString() }.filter { it.isNotBlank() }
            is String -> raw.split(",").map { it.trim() }.filter { it.isNotBlank() }
            else -> throw IllegalArgumentException("ruleNames must be an array or a comma-separated string")
        }
    }

    // ------------------------------------------------------------------
    // Envelope items
    // ------------------------------------------------------------------

    private fun engineItem(): Map<String, Any> = AnalysisResultUtils.item(
        id = "engine",
        kind = "taint_engine",
        title = "Tai-e 0.5.4 pointer analysis + taint (PacDroid Android modeling)",
        meta = linkedMapOf(
            "engine" to "taie",
            "version" to "0.5.4",
            "algorithms" to listOf("pta"),
            "contextSensitivities" to listOf("ci", "1obj", "2obj", "2-type", "2obj+H"),
            "scopes" to listOf("APP", "REACHABLE")
        )
    )

    private fun environmentItem(): Map<String, Any> = AnalysisResultUtils.item(
        id = "environment",
        kind = "taint_environment",
        title = if (env.isReady()) "ready" else "not ready",
        meta = env.status()
    )

    private fun ruleItem(rule: TaintRule): Map<String, Any> = AnalysisResultUtils.item(
        id = rule.name,
        kind = ITEM_KIND_RULE,
        title = rule.name,
        content = rule.description,
        meta = linkedMapOf(
            "name" to rule.name,
            "description" to rule.description,
            "category" to rule.category,
            "severity" to rule.severity,
            "origin" to rule.origin,
            "sourceCount" to rule.sources.size,
            "sinkCount" to rule.sinks.size,
            "transferCount" to rule.transfers.size,
            "sanitizerCount" to rule.sanitizers.size
        )
    )

    private fun jobItem(snapshot: Map<String, Any>): Map<String, Any> = AnalysisResultUtils.item(
        id = snapshot["jobId"]?.toString() ?: "unknown",
        kind = ITEM_KIND_JOB,
        title = "${snapshot["jobId"]}: ${snapshot["state"]}",
        content = snapshot["message"]?.toString() ?: "",
        meta = snapshot
    )

    private fun flowItem(
        index: Int,
        flow: TaintFlowDto,
        attribution: TaintRuleCompiler.Attribution
    ): Map<String, Any> {
        val severity = attribution.rules
            .map { SEVERITY_ORDER.indexOf(it.severity) }
            .maxOrNull()
            ?.let { if (it >= 0) SEVERITY_ORDER[it] else TaintRule.SEVERITY_MEDIUM }
            ?: TaintRule.SEVERITY_MEDIUM
        return AnalysisResultUtils.item(
            id = "flow-$index",
            kind = ITEM_KIND_FLOW,
            title = "${flow.sourceMethod} -> ${flow.sinkMethod}",
            content = "${flow.source}\n  ->\n${flow.sink}",
            meta = linkedMapOf(
                "source" to flow.source,
                "sink" to flow.sink,
                "source_method" to flow.sourceMethod,
                "sink_method" to flow.sinkMethod,
                "source_line" to (flow.sourceLine ?: 0),
                "sink_line" to (flow.sinkLine ?: 0),
                "rules" to attribution.rules.map { it.name },
                "severity" to severity,
                "categories" to attribution.rules.map { it.category }.filter { it.isNotBlank() }.distinct(),
                "cross_rule" to attribution.crossRule
            )
        )
    }

    // ------------------------------------------------------------------
    // Target resolution
    // ------------------------------------------------------------------

    private fun resolveApk(config: TaintConfig): String {
        config.target.apk?.let { apk ->
            if (!File(apk).isFile) throw IllegalArgumentException("target.apk not found: $apk")
            return apk
        }
        val session = config.target.session
            ?: throw IllegalArgumentException("taint target: session or apk is required")
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
}
