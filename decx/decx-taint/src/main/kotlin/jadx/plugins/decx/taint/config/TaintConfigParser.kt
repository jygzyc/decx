package jadx.plugins.decx.taint.config

/**
 * Parses a [TaintConfig] from a request payload map (already JSON-decoded by
 * the transport). Recognized keys: `target{session|apk, platforms}`,
 * `analysis{contextSensitivity, scope, distinguishStrings}`,
 * `limits{timeoutSec, maxPointerAnalyzeTimeSec}`. Unknown keys are ignored so
 * the payload can carry rule fields alongside.
 */
object TaintConfigParser {

    private val CONTEXT_SENSITIVITIES = setOf("ci", "1obj", "2obj", "2-type", "2obj+H")
    private val SCOPES = setOf("APP", "REACHABLE")

    fun fromPayload(payload: Map<String, Any>): TaintConfig {
        val targetObj = payload["target"] as? Map<*, *>
        if (targetObj == null) {
            throw IllegalArgumentException("taint target: session or apk is required")
        }
        val target = TargetConfig(
            session = targetObj["session"]?.toString()?.takeIf { it.isNotBlank() },
            apk = targetObj["apk"]?.toString()?.takeIf { it.isNotBlank() },
            platforms = targetObj["platforms"]?.toString()?.takeIf { it.isNotBlank() }
        )
        target.resolveTarget() // fail fast on missing/ambiguous target

        val analysisObj = payload["analysis"] as? Map<*, *> ?: emptyMap<String, Any>()
        val cs = analysisObj["contextSensitivity"]?.toString() ?: "ci"
        if (cs !in CONTEXT_SENSITIVITIES) {
            throw IllegalArgumentException("analysis.contextSensitivity '$cs' unsupported (${CONTEXT_SENSITIVITIES.joinToString("|")})")
        }
        val scope = analysisObj["scope"]?.toString()?.uppercase() ?: "APP"
        if (scope !in SCOPES) {
            throw IllegalArgumentException("analysis.scope '$scope' unsupported (${SCOPES.joinToString("|")})")
        }
        val analysis = AnalysisConfig(
            contextSensitivity = cs,
            scope = scope,
            distinguishStrings = analysisObj["distinguishStrings"] == true
        )

        val limitsObj = payload["limits"] as? Map<*, *> ?: emptyMap<String, Any>()
        val limits = LimitsConfig(
            timeoutSec = limitsObj.intAtLeast("timeoutSec", 1, default = 600),
            maxPointerAnalyzeTimeSec = limitsObj.intAtLeast("maxPointerAnalyzeTimeSec", 1, default = 300)
        )

        return TaintConfig(target = target, analysis = analysis, limits = limits)
    }

    private fun Map<*, *>.intAtLeast(name: String, min: Int, default: Int): Int {
        val raw = this[name] ?: return default
        val value = when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull() ?: throw IllegalArgumentException("limits.$name must be an integer, got: '$raw'")
            else -> throw IllegalArgumentException("limits.$name must be an integer")
        }
        if (value < min) throw IllegalArgumentException("limits.$name must be >= $min, got: $value")
        return value
    }
}
