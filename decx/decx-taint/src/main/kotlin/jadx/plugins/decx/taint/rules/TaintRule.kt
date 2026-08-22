package jadx.plugins.decx.taint.rules

/**
 * AppShark-style taint rule (JSON).
 *
 * A rule document is a JSON object mapping rule names to rule bodies:
 *
 * ```json
 * {
 *   "deviceIdLeak": {
 *     "description": "Device identifiers reach network/log/SMS sinks",
 *     "category": "PrivacyLeak",
 *     "severity": "high",
 *     "sources":   [{ "method": "<android.telephony.TelephonyManager: java.lang.String getDeviceId()>", "index": "result" }],
 *     "sinks":     [{ "method": "<android.util.Log: int i(java.lang.String,java.lang.String)>", "index": 1 }],
 *     "transfers": [{ "method": "<java.lang.StringBuilder: java.lang.StringBuilder append(java.lang.String)>", "from": "base", "to": "result" }],
 *     "sanitizers": []
 *   }
 * }
 * ```
 *
 * Method signatures use the Tai-e/Jimple fully-qualified form
 * `<class: returnType name(paramTypes)>`. `index`/`from`/`to` are either
 * `result`, `base`, or a 0-based parameter position. Wildcards are not
 * supported in v1.
 */
data class TaintRule(
    val name: String,
    val description: String = "",
    val category: String = "",
    val severity: String = SEVERITY_MEDIUM,
    val sources: List<RuleEntry>,
    val sinks: List<RuleEntry>,
    val transfers: List<RuleTransfer> = emptyList(),
    val sanitizers: List<RuleEntry> = emptyList(),
    /** Where the rule came from: "builtin", "inline", or a file path. */
    val origin: String = "inline"
) {
    companion object {
        const val SEVERITY_INFO = "info"
        const val SEVERITY_LOW = "low"
        const val SEVERITY_MEDIUM = "medium"
        const val SEVERITY_HIGH = "high"
        const val SEVERITY_CRITICAL = "critical"
        val SEVERITIES = setOf(SEVERITY_INFO, SEVERITY_LOW, SEVERITY_MEDIUM, SEVERITY_HIGH, SEVERITY_CRITICAL)

        const val ORIGIN_BUILTIN = "builtin"
        const val ORIGIN_INLINE = "inline"
    }
}

/** A taint source or sink: one method plus the tainted position. */
data class RuleEntry(
    val method: String,
    /** "result", "base", or a 0-based parameter index as a decimal string. */
    val index: String
)

/** A taint transfer through a method (e.g. StringBuilder.append). */
data class RuleTransfer(
    val method: String,
    val from: String,
    val to: String
)
