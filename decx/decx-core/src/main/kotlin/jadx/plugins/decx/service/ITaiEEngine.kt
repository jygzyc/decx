package jadx.plugins.decx.service

/**
 * Contract between DECX core and the Tai-e static analysis engine.
 *
 * This interface lives in decx-core and has zero Tai-e imports. The concrete
 * implementation [jadx.plugins.decx.taie.TaiEEngineClient] lives in decx-core
 * as an IPC client that talks to the TaiEEngine process (decx-taie-engine module).
 *
 * The engine serves three core APIs for taint analysis:
 * 1. [getRules] — query available preset rules
 * 2. [investigate] — execute a preset rule by ID (with optional parameters)
 * 3. [investigateCustom] — execute an AI-provided inline rule
 *
 * Additionally, it provides CG/xref queries (callersOf, calleesOf, etc.)
 * that replace JADX's single-level useIn with dispatch-resolved call graph.
 *
 * When the engine is null (disabled) or not yet ready, DECX endpoints
 * fall back to the existing JADX-based logic.
 */
interface ITaiEEngine {

    /** Tier 1 readiness: engine process is alive and accepting requests. */
    val isReady: Boolean

    /** Tier 2 readiness: pointer analysis is complete. */
    val isAnalysisReady: Boolean

    // ------------------------------------------------------------------
    // CG / xref queries (replace JADX useIn)
    // ------------------------------------------------------------------

    fun callersOf(methodSig: String): List<CallEdge>
    fun calleesOf(methodSig: String): List<CallEdge>
    fun subclassesOf(classSig: String, transitive: Boolean): List<String>
    fun implementorsOf(ifaceSig: String, transitive: Boolean): List<String>

    // ------------------------------------------------------------------
    // Three core taint analysis interfaces
    // ------------------------------------------------------------------

    /**
     * Interface 1: Query rules.
     * Returns preset rules loaded from ~/.decx/rules/ at engine startup.
     */
    fun getRules(): List<RuleSummary>

    /**
     * Interface 2: Execute a preset rule by ID.
     * @param ruleId the rule ID from [getRules]
     * @param params parameter values to substitute into the rule's {{param}} placeholders
     * @return source→sink taint paths
     */
    fun investigate(ruleId: String, params: Map<String, String> = emptyMap()): List<TaintPath>

    /**
     * Interface 3: Execute a custom inline rule.
     * @param ruleYaml full rule definition in YAML (source/sink/sanitizer/trace_depth)
     * @param params parameter values to substitute into {{param}} placeholders
     * @return source→sink taint paths
     */
    fun investigateCustom(ruleYaml: String, params: Map<String, String> = emptyMap()): List<TaintPath>

    // ------------------------------------------------------------------
    // Variable tracking (pointer analysis)
    // ------------------------------------------------------------------

    fun pointsTo(methodSig: String, varName: String): List<String>

    // ------------------------------------------------------------------
    // Android vulnerability modeling
    // ------------------------------------------------------------------

    fun dynamicReceivers(): List<DynamicReceiverInfo>
    fun iccTargets(componentSig: String): List<IccTarget>
    fun registeredCallbacks(componentSig: String): List<CallbackInfo>

    // ------------------------------------------------------------------
    // Evidence data classes
    // ------------------------------------------------------------------

    data class RuleSummary(
        val id: String,
        val name: String,
        val description: String,
        val parameters: List<RuleParameter>? = null
    )

    data class RuleParameter(
        val name: String,
        val type: String,
        val description: String,
        val required: Boolean,
        val defaultValue: String? = null
    )

    data class TaintPath(
        val ruleId: String,
        val source: String,
        val sink: String,
        val steps: List<TaintStep>
    )

    data class TaintStep(
        val method: String,
        val line: Int,
        val desc: String
    )

    data class CallEdge(
        val from: String,
        val to: String,
        val invokeType: String,
        val line: Int?
    )

    data class DynamicReceiverInfo(
        val registerMethod: String,
        val receiverClass: String,
        val actionFilters: List<String>
    )

    data class IccTarget(
        val sourceComponent: String,
        val intentCall: String,
        val targetComponent: String,
        val isExplicit: Boolean
    )

    data class CallbackInfo(
        val hostClass: String,
        val callbackMethod: String,
        val interfaceType: String
    )
}
