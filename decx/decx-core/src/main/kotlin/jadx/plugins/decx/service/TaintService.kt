package jadx.plugins.decx.service

import jadx.api.JadxDecompiler
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxError
import jadx.plugins.decx.api.DecxKind
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.ItemKind

/**
 * Service for taint analysis via the TaiEEngine.
 *
 * Three handler methods map to the three core ITaiEEngine interfaces:
 * - [handleGetRules] → query available preset rules
 * - [handleInvestigate] → execute a preset rule by ID
 * - [handleInvestigateCustom] → execute an AI-provided inline rule
 *
 * This service is a thin delegate — all analysis logic lives in the TaiEEngine
 * process. When the engine is unavailable, handlers return a SERVICE_ERROR.
 */
class TaintService(
    override val decompiler: JadxDecompiler,
    private val taiEEngine: ITaiEEngine? = null
) : DecompilerBackedService {

    /** Returns the TaiEEngine, or null if not available. */
    fun getEngine(): ITaiEEngine? = taiEEngine

    /** Interface 1: list available preset taint rules. */
    fun handleGetRules(): DecxApiResult {
        val query = emptyMap<String, Any>()
        val engine = taiEEngine
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.VULN_RULES, query, DecxError.SERVICE_ERROR,
                    if (engine == null) "TaiEEngine not available (start server with --tai-e)"
                    else "TaiEEngine not ready (still initializing)")
            )
        }
        val rules = engine.getRules()
        val items = rules.map { rule ->
            AnalysisResultUtils.item(
                id = rule.id,
                kind = ItemKind.SYMBOL,
                title = "Rule: ${rule.name}",
                content = rule.description,
                meta = linkedMapOf(
                    "name" to rule.name,
                    "description" to rule.description,
                    "parameters" to (rule.parameters ?: emptyList<Any>())
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.VULN_RULES, query, items))
    }

    /** Interface 2: execute a preset rule by ID. */
    fun handleInvestigate(ruleId: String, params: Map<String, String>): DecxApiResult {
        val query = mapOf("rule_id" to ruleId, "params" to params)
        val engine = taiEEngine
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.INVESTIGATE, query, DecxError.SERVICE_ERROR,
                    if (engine == null) "TaiEEngine not available"
                    else "TaiEEngine not ready")
            )
        }
        val paths = engine.investigate(ruleId, params)
        val items = paths.map { path ->
            AnalysisResultUtils.item(
                id = "${path.ruleId}#${path.source}#${path.sink}",
                kind = ItemKind.VULN_FINDING,
                title = "Taint: ${path.source} -> ${path.sink}",
                content = path.steps.joinToString("\n") { "  ${it.method}:${it.line} ${it.desc}" },
                meta = linkedMapOf(
                    "rule_id" to path.ruleId,
                    "source" to path.source,
                    "sink" to path.sink,
                    "steps" to path.steps
                )
            )
        }
        val summary = mapOf(
            "rule_id" to ruleId,
            "path_count" to items.size
        )
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.INVESTIGATE, query, items, summary))
    }

    /** Interface 3: execute a custom inline rule. */
    fun handleInvestigateCustom(ruleYaml: String, params: Map<String, String>): DecxApiResult {
        val query = mapOf("rule_yaml_length" to ruleYaml.length, "params" to params)
        val engine = taiEEngine
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.INVESTIGATE, query, DecxError.SERVICE_ERROR,
                    if (engine == null) "TaiEEngine not available"
                    else "TaiEEngine not ready")
            )
        }
        val paths = engine.investigateCustom(ruleYaml, params)
        val items = paths.map { path ->
            AnalysisResultUtils.item(
                id = "custom#${path.source}#${path.sink}",
                kind = ItemKind.VULN_FINDING,
                title = "Taint: ${path.source} -> ${path.sink}",
                content = path.steps.joinToString("\n") { "  ${it.method}:${it.line} ${it.desc}" },
                meta = linkedMapOf(
                    "rule_id" to path.ruleId,
                    "source" to path.source,
                    "sink" to path.sink,
                    "steps" to path.steps
                )
            )
        }
        val summary = mapOf("path_count" to items.size)
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.INVESTIGATE, query, items, summary))
    }
}
