package jadx.plugins.decx.service

import jadx.api.JadxDecompiler
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxError
import jadx.plugins.decx.api.DecxKind
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.ItemKind

/**
 * Service that orchestrates evidence collection for vulnerability investigation.
 *
 * This service does NOT make vulnerability judgments. It collects structured
 * evidence (callers, callees, variable flow, ICC targets, dynamic receivers,
 * callbacks) from the [ITaiEEngine] and returns it as DECX result items.
 * The AI consuming the DECX endpoints performs the actual vulnerability reasoning.
 *
 * Two usage modes:
 * 1. **Rule-based**: call `handleInvestigate(ruleId)` with a loaded investigation
 *    rule — the service executes the rule's targets + collect directives and
 *    aggregates the evidence.
 * 2. **Direct**: call individual handlers (`handlePointsTo`, `handleIccTargets`,
 *    etc.) for ad-hoc evidence queries without a rule.
 *
 * The service holds a reference to loaded rules (populated by the server at
 * startup from `~/.decx/rules/`). Rule data classes live in decx-server (they
 * use Jackson YAML annotations), so the server passes them as simple maps.
 */
class VulnHuntService(
    override val decompiler: JadxDecompiler,
    private val taiEEngine: ITaiEEngine? = null,
    private val rules: List<RuleSummary> = emptyList()
) : DecompilerBackedService {

    /**
     * Summary of an investigation rule, passed from the server.
     * The full rule spec (targets/collect/context) is held server-side;
     * core only needs the summary for listing and ID lookup.
     */
    data class RuleSummary(
        val id: String,
        val description: String,
        val category: String,
        val targetSdk: String? = null
    )

    /**
     * A loaded rule with its full collect directives, passed from the server
     * when the server wants the core to execute an investigation.
     */
    data class RuleExecution(
        val summary: RuleSummary,
        val targets: List<TargetSpec>,
        val collect: List<CollectSpec>,
        val context: List<ContextSpec>?
    )
    data class TargetSpec(val kind: String, val signature: String)
    data class CollectSpec(
        val kind: String, val variable: String?, val depth: Int?,
        val includeCallees: Boolean, val fromCallersOf: String?
    )
    data class ContextSpec(val kind: String, val component: String?)

    /** Lists available investigation rules. */
    fun handleGetRules(): DecxApiResult {
        val query = emptyMap<String, Any>()
        val items = rules.map { rule ->
            AnalysisResultUtils.item(
                id = rule.id,
                kind = ItemKind.SYMBOL,
                title = "Rule: ${rule.id}",
                content = rule.description,
                meta = linkedMapOf(
                    "category" to rule.category,
                    "target_sdk" to (rule.targetSdk ?: "any")
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.VULN_RULES, query, items))
    }

    /**
     * Executes an investigation rule: collects evidence per the rule's
     * targets + collect directives, and returns aggregated evidence items.
     */
    fun handleInvestigate(ruleExecution: RuleExecution): DecxApiResult {
        val ruleId = ruleExecution.summary.id
        val query = mapOf("rule_id" to ruleId)
        val engine = taiEEngine
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.INVESTIGATE, query, DecxError.SERVICE_ERROR,
                    if (engine == null) "Tai-e engine not available (start server with --tai-e)"
                    else "Tai-e engine not ready yet (still initializing)")
            )
        }
        val items = mutableListOf<Map<String, Any>>()
        var evidenceIndex = 0

        for (target in ruleExecution.targets) {
            val targetSig = target.signature
            for (collectSpec in ruleExecution.collect) {
                val evidenceItems = collectEvidence(engine, targetSig, collectSpec, evidenceIndex)
                items.addAll(evidenceItems)
                evidenceIndex += evidenceItems.size
            }
        }

        // Context evidence (not tied to a specific target)
        ruleExecution.context?.forEach { ctxSpec ->
            val ctxItems = collectContext(engine, ctxSpec, evidenceIndex)
            items.addAll(ctxItems)
            evidenceIndex += ctxItems.size
        }

        val summary = mapOf(
            "rule_id" to ruleId,
            "rule_category" to ruleExecution.summary.category,
            "evidence_count" to items.size,
            "target_count" to ruleExecution.targets.size
        )
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.INVESTIGATE, query, items, summary))
    }

    /** Direct points-to query for a variable in a method. */
    fun handlePointsTo(methodSig: String, varName: String): DecxApiResult {
        val query = mapOf("method" to methodSig, "variable" to varName)
        val engine = taiEEngine
        if (engine == null || !engine.isAnalysisReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.POINTS_TO, query, DecxError.SERVICE_ERROR,
                    if (engine == null) "Tai-e engine not available"
                    else "Tai-e pointer analysis not ready (still running or timed out)")
            )
        }
        val pts = engine.pointsTo(methodSig, varName)
        val items = pts.mapIndexed { i, desc ->
            AnalysisResultUtils.item(
                id = "$methodSig#$varName#$i",
                kind = ItemKind.EVIDENCE,
                title = "Allocation: $desc",
                content = desc,
                meta = linkedMapOf(
                    "method" to methodSig,
                    "variable" to varName,
                    "source" to "taie"
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.POINTS_TO, query, items))
    }

    /** Direct dynamic receivers query. */
    fun handleGetDynamicReceivers(): DecxApiResult {
        val query = emptyMap<String, Any>()
        val engine = taiEEngine
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.DYNAMIC_RECEIVERS_TAIE, query, DecxError.SERVICE_ERROR,
                    "Tai-e engine not available or not ready")
            )
        }
        val receivers = engine.dynamicReceivers()
        val items = receivers.mapIndexed { i, recv ->
            AnalysisResultUtils.item(
                id = "dynamic-receiver-$i",
                kind = ItemKind.EVIDENCE,
                title = "Dynamic receiver: ${recv.receiverClass}",
                content = "${recv.receiverClass} registered in ${recv.registerMethod}",
                meta = linkedMapOf(
                    "register_method" to recv.registerMethod,
                    "receiver_class" to recv.receiverClass,
                    "action_filters" to recv.actionFilters,
                    "source" to "taie"
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.DYNAMIC_RECEIVERS_TAIE, query, items))
    }

    /** Direct ICC targets query. */
    fun handleGetIccTargets(componentSig: String): DecxApiResult {
        val query = mapOf("component" to componentSig)
        val engine = taiEEngine
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.ICC_TARGETS, query, DecxError.SERVICE_ERROR,
                    "Tai-e engine not available or not ready")
            )
        }
        val targets = engine.iccTargets(componentSig)
        val items = targets.mapIndexed { i, tgt ->
            AnalysisResultUtils.item(
                id = "icc-target-$i",
                kind = ItemKind.EVIDENCE,
                title = "ICC: ${tgt.sourceComponent} -> ${tgt.targetComponent.ifEmpty { "?" }}",
                content = "${tgt.intentCall} from ${tgt.sourceComponent}",
                meta = linkedMapOf(
                    "source_component" to tgt.sourceComponent,
                    "intent_call" to tgt.intentCall,
                    "target_component" to tgt.targetComponent,
                    "is_explicit" to tgt.isExplicit,
                    "source" to "taie"
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.ICC_TARGETS, query, items))
    }

    /** Direct registered callbacks query. */
    fun handleGetCallbacks(componentSig: String): DecxApiResult {
        val query = mapOf("component" to componentSig)
        val engine = taiEEngine
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.CALLBACKS, query, DecxError.SERVICE_ERROR,
                    "Tai-e engine not available or not ready")
            )
        }
        val callbacks = engine.registeredCallbacks(componentSig)
        val items = callbacks.mapIndexed { i, cb ->
            AnalysisResultUtils.item(
                id = "callback-$i",
                kind = ItemKind.EVIDENCE,
                title = "Callback: ${cb.callbackMethod}",
                content = "${cb.hostClass} registers ${cb.callbackMethod} (${cb.interfaceType})",
                meta = linkedMapOf(
                    "host_class" to cb.hostClass,
                    "callback_method" to cb.callbackMethod,
                    "interface_type" to cb.interfaceType,
                    "source" to "taie"
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.CALLBACKS, query, items))
    }

    // ------------------------------------------------------------------
    // Accessors
    // ------------------------------------------------------------------

    /** Returns the Tai-e engine, or null if not available. */
    fun getEngine(): ITaiEEngine? = taiEEngine

    // ------------------------------------------------------------------
    // Evidence collection helpers
    // ------------------------------------------------------------------

    private fun collectEvidence(
        engine: ITaiEEngine,
        targetSig: String,
        spec: CollectSpec,
        startIndex: Int
    ): List<Map<String, Any>> {
        return when (spec.kind) {
            "callers" -> {
                val callers = engine.callersOf(targetSig)
                val items = callers.mapIndexed { i, edge ->
                    evidenceItem(
                        id = "evidence-${startIndex + i}",
                        title = "Caller: ${edge.from}",
                        content = "${edge.from} calls $targetSig (${edge.invokeType})",
                        meta = linkedMapOf(
                            "target" to targetSig,
                            "caller" to edge.from,
                            "invoke_type" to edge.invokeType,
                            "line" to (edge.line ?: 0),
                            "evidence_kind" to "callers"
                        )
                    )
                }
                if (spec.includeCallees) {
                    val callees = engine.calleesOf(targetSig)
                    items + callees.mapIndexed { i, edge ->
                        evidenceItem(
                            id = "evidence-${startIndex + items.size + i}",
                            title = "Callee: ${edge.to}",
                            content = "$targetSig calls ${edge.to} (${edge.invokeType})",
                            meta = linkedMapOf(
                                "target" to targetSig,
                                "callee" to edge.to,
                                "invoke_type" to edge.invokeType,
                                "evidence_kind" to "callees"
                            )
                        )
                    }
                } else items
            }
            "callees" -> {
                engine.calleesOf(targetSig).mapIndexed { i, edge ->
                    evidenceItem(
                        id = "evidence-${startIndex + i}",
                        title = "Callee: ${edge.to}",
                        content = "$targetSig calls ${edge.to}",
                        meta = linkedMapOf(
                            "target" to targetSig, "callee" to edge.to,
                            "invoke_type" to edge.invokeType, "evidence_kind" to "callees"
                        )
                    )
                }
            }
            "variable_flow", "points_to" -> {
                val varName = spec.variable ?: "return"
                val pts = engine.pointsTo(targetSig, varName)
                pts.mapIndexed { i, desc ->
                    evidenceItem(
                        id = "evidence-${startIndex + i}",
                        title = "Points-to: $varName -> $desc",
                        content = "Variable '$varName' in $targetSig points to: $desc",
                        meta = linkedMapOf(
                            "target" to targetSig, "variable" to varName,
                            "allocation" to desc, "evidence_kind" to "points_to"
                        )
                    )
                }
            }
            "icc_targets" -> {
                // If from_callers_of is specified, query ICC for that component;
                // otherwise query for the target itself.
                val component = spec.fromCallersOf ?: targetSig
                engine.iccTargets(component).mapIndexed { i, tgt ->
                    evidenceItem(
                        id = "evidence-${startIndex + i}",
                        title = "ICC: ${tgt.sourceComponent} -> ${tgt.targetComponent.ifEmpty { "?" }}",
                        content = "${tgt.intentCall} (explicit=${tgt.isExplicit})",
                        meta = linkedMapOf(
                            "source_component" to tgt.sourceComponent,
                            "intent_call" to tgt.intentCall,
                            "target_component" to tgt.targetComponent,
                            "is_explicit" to tgt.isExplicit,
                            "evidence_kind" to "icc_targets"
                        )
                    )
                }
            }
            else -> emptyList()
        }
    }

    private fun collectContext(
        engine: ITaiEEngine,
        spec: ContextSpec,
        startIndex: Int
    ): List<Map<String, Any>> {
        return when (spec.kind) {
            "dynamic_receivers" -> {
                engine.dynamicReceivers().mapIndexed { i, recv ->
                    evidenceItem(
                        id = "evidence-${startIndex + i}",
                        title = "Dynamic receiver: ${recv.receiverClass}",
                        content = "${recv.receiverClass} (actions: ${recv.actionFilters.joinToString(", ")})",
                        meta = linkedMapOf(
                            "register_method" to recv.registerMethod,
                            "receiver_class" to recv.receiverClass,
                            "action_filters" to recv.actionFilters,
                            "evidence_kind" to "dynamic_receivers"
                        )
                    )
                }
            }
            "callbacks" -> {
                engine.registeredCallbacks(spec.component ?: "").mapIndexed { i, cb ->
                    evidenceItem(
                        id = "evidence-${startIndex + i}",
                        title = "Callback: ${cb.callbackMethod}",
                        content = "${cb.hostClass} (${cb.interfaceType})",
                        meta = linkedMapOf(
                            "host_class" to cb.hostClass,
                            "callback_method" to cb.callbackMethod,
                            "interface_type" to cb.interfaceType,
                            "evidence_kind" to "callbacks"
                        )
                    )
                }
            }
            else -> emptyList()
        }
    }

    private fun evidenceItem(id: String, title: String, content: String, meta: Map<String, Any>): Map<String, Any> {
        return AnalysisResultUtils.item(id, ItemKind.EVIDENCE, title, content, meta)
    }
}
