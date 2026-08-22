package jadx.plugins.decx.taint.config

/**
 * Taint analysis request configuration (target + engine tuning). Rule
 * selection lives in [jadx.plugins.decx.taint.rules.TaintRule] documents;
 * the compiled rule set travels alongside this config as the worker's taint
 * fragment.
 */
data class TaintConfig(
    val target: TargetConfig,
    val analysis: AnalysisConfig = AnalysisConfig(),
    val limits: LimitsConfig = LimitsConfig()
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
    /** Context sensitivity: ci | 1obj | 2obj | 2-type | 2obj+H (Tai-e pta `cs`). */
    val contextSensitivity: String = "ci",
    /** Analysis scope: APP | REACHABLE (Tai-e CLI-level `-scope`). */
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
