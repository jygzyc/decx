package decx.taie

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty

/**
 * An AppShark-style taint analysis rule in YAML format.
 *
 * Rules define source methods (where tainted data originates), sink methods
 * (where tainted data is consumed/dangerous), and optional sanitizers (methods
 * that "clean" the taint). The TaiEEngine executes the rule by running PTA +
 * taint propagation and returns source→sink paths.
 *
 * Rules support parameterization via `{{param_name}}` template placeholders.
 * When executing via the `investigate` API, callers provide parameter values
 * that are substituted into the rule before analysis.
 *
 * YAML format:
 * ```yaml
 * id: intent_redirection
 * name: "Intent Redirection"
 * description: "Detect intent redirection via Parcelable extras"
 * severity: high
 * category: intent_redirection
 * trace_depth: 10
 * parameters:
 *   - name: source_method
 *     type: method_signature
 *     description: "Method whose return value is the taint source"
 *     required: true
 * source:
 *   - kind: return
 *     method: "<android.os.BaseBundle: android.os.Parcelable getParcelable(java.lang.String)>"
 * sink:
 *   - method: "<android.app.Activity: void startActivity(android.content.Intent)>"
 *     taint_check: ["p0"]
 *     param_type: ["android.content.Intent"]
 * sanitizer:
 *   - name: null_check
 *     method: "<java.lang.Object: boolean equals(java.lang.Object)>"
 *     taint_check: ["p0"]
 * ```
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class VulnRule(
    @JsonProperty("id") val id: String? = "",
    @JsonProperty("name") val name: String? = "",
    @JsonProperty("description") val description: String? = "",
    @JsonProperty("severity") val severity: String? = "medium",
    @JsonProperty("category") val category: String? = "general",
    @JsonProperty("trace_depth") val traceDepth: Int? = 10,
    @JsonProperty("parameters") val parameters: List<RuleParameter>? = null,
    @JsonProperty("source") val source: List<SourceSpec>? = null,
    @JsonProperty("sink") val sink: List<SinkSpec>? = null,
    @JsonProperty("sanitizer") val sanitizer: List<SanitizerSpec>? = null
) {

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class RuleParameter(
        @JsonProperty("name") val name: String,
        @JsonProperty("type") val type: String,
        @JsonProperty("description") val description: String,
        @JsonProperty("required") val required: Boolean,
        @JsonProperty("default_value") val defaultValue: String? = null
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class SourceSpec(
        @JsonProperty("kind") val kind: String,        // "return" | "param" | "field" | "new_instance"
        @JsonProperty("method") val method: String,
        @JsonProperty("position") val position: String? = null  // for "param" kind: "p0", "p1", etc.
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class SinkSpec(
        @JsonProperty("method") val method: String,
        @JsonProperty("taint_check") val taintCheck: List<String>,  // "p0".."pN" | "p*" | "@this" | "return"
        @JsonProperty("param_type") val paramType: List<String>? = null
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class SanitizerSpec(
        @JsonProperty("name") val name: String,
        @JsonProperty("method") val method: String,
        @JsonProperty("taint_check") val taintCheck: List<String>? = null
    )

    /**
     * Substitutes {{param}} placeholders in all method signatures with actual
     * values from [params]. Returns a new rule with substituted signatures.
     */
    fun resolveParams(params: Map<String, String>): VulnRule {
        fun substitute(s: String): String {
            var result = s
            params.forEach { (key, value) ->
                result = result.replace("{{$key}}", value)
            }
            return result
        }
        return copy(
            source = source?.map { it.copy(method = substitute(it.method), position = it.position?.let(::substitute)) },
            sink = sink?.map { spec ->
                spec.copy(
                    method = substitute(spec.method),
                    taintCheck = spec.taintCheck.map(::substitute),
                    paramType = spec.paramType?.map(::substitute)
                )
            },
            sanitizer = sanitizer?.map { spec ->
                spec.copy(
                    method = substitute(spec.method),
                    taintCheck = spec.taintCheck?.map(::substitute)
                )
            }
        )
    }
}
