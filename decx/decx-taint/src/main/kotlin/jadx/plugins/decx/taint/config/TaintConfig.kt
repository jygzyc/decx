package jadx.plugins.decx.taint.config

/**
 * Configuration model for the DECX taint engine.
 *
 * Design (candidate 1, user-approved): preset inheritance + field-level
 * override + raw escape hatch. A config either references a built-in preset
 * (which supplies analysis/limits/taint defaults) or fully defines them;
 * user-supplied fields always win over preset defaults; `raw` passes through
 * engine-specific options the DECX schema does not model.
 *
 * All configs are transport-agnostic: they arrive as YAML over HTTP/MCP, are
 * resolved here into a [TaintConfig], and are handed to the worker engine.
 */

/** Top-level taint analysis request. */
data class TaintConfig(
    /** Engine id. Defaults to "taie"; kept so future engines can be mounted. */
    val engine: String = "taie",
    /** Analysis target (session or direct apk). */
    val target: TargetConfig,
    /** Pointer-analysis / call-graph tuning. */
    val analysis: AnalysisConfig = AnalysisConfig(),
    /** Timeouts and depth/pruning limits. */
    val limits: LimitsConfig = LimitsConfig(),
    /** Taint source/sink/transfer/sanitizer rules. */
    val taint: TaintRulesConfig = TaintRulesConfig(),
    /** Raw Tai-e plan options, passed through verbatim to the worker. */
    val raw: Map<String, Any>? = null
)

data class TargetConfig(
    /** Reuse an already-open DECX session by name (its APK + platforms). */
    val session: String? = null,
    /** Direct path to an APK to analyze. */
    val apk: String? = null,
    /** Android platforms directory (defaults to DECX_HOME/platforms). */
    val platforms: String? = null
) {
    /** Exactly one of session/apk must be provided. */
    fun resolveTarget(): String {
        if (session != null && apk != null) {
            throw IllegalArgumentException("taint target: specify either session or apk, not both")
        }
        return session ?: apk
            ?: throw IllegalArgumentException("taint target: session or apk is required")
    }
}

data class AnalysisConfig(
    /** Pointer analysis algorithm: pta (taint-capable) | cha (not taint-capable in Tai-e 0.5.4). */
    val algorithm: String = "pta",
    /** Context sensitivity: ci | 1obj | 2obj | 2-type | ... (Tai-e pta `cs`). */
    val contextSensitivity: String = "ci",
    /** Analysis scope: APP | REACHABLE (CLI-level `-scope`). */
    val scope: String = "APP",
    /** Distinguish string constants (Tai-e pta `distinguish-string-constants: all`). */
    val distinguishStrings: Boolean = false
)

data class LimitsConfig(
    /** Hard wall-clock timeout for the whole analysis. */
    val timeoutSec: Int = 600,
    /** Per-entry-point pointer-analysis time budget. */
    val maxPointerAnalyzeTimeSec: Int = 300
)

data class TaintRulesConfig(
    val callSiteMode: Boolean = true,
    val sources: List<Map<String, Any>> = emptyList(),
    val sinks: List<Map<String, Any>> = emptyList(),
    val transfers: List<Map<String, Any>> = emptyList(),
    val sanitizers: List<Map<String, Any>> = emptyList()
) {
    val isEmpty: Boolean
        get() = sources.isEmpty() && sinks.isEmpty() && transfers.isEmpty() && sanitizers.isEmpty()
}
