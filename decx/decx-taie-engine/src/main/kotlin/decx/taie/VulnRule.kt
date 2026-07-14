package decx.taie

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty

/**
 * AppShark-aligned taint analysis rule in YAML format.
 *
 * Rules define source methods (where tainted data originates), sink methods
 * (where tainted data is consumed/dangerous), optional sanitizers (methods
 * that "clean" the taint), and library taint transfers (modeling opaque
 * container semantics like Intent/Bundle/Map).
 *
 * The engine converts rules to Tai-e Source/Sink/Transfer objects via
 * DecxTaintConfigProvider and runs Tai-e's TaintAnalysis plugin.
 *
 * YAML format (aligned with AppShark):
 * ```yaml
 * id: intent_redirection
 * name: "Intent Redirection"
 * description: "Parcelable extra to startActivity"
 * severity: high
 * trace_depth: 6
 * source:
 *   return:
 *     - "<android.content.Intent: android.os.Parcelable getParcelable*(java.lang.String)>"
 *   param:
 *     "<com.example.Foo: void bar(java.lang.String)>": ["p0"]
 *   new_instance:
 *     - "android.content.Intent"
 * sink:
 *   "<android.app.Activity: void startActivity(android.content.Intent)>":
 *     taint_check: ["p0"]
 * sanitizer:
 *   null_check:
 *     "<java.lang.Object: boolean equals(java.lang.Object)>":
 *       taint_check: ["p0"]
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
    @JsonProperty("prim_type_as_taint") val primTypeAsTaint: Boolean? = false,
    @JsonProperty("source") val source: VulnSource? = null,
    @JsonProperty("sink") val sink: Map<String, VulnSink>? = null,
    @JsonProperty("sanitizer") val sanitizer: Map<String, Map<String, VulnSinkBody>>? = null,
    @JsonProperty("entry") val entry: VulnEntry? = null
) {

    /**
     * Source specification aligned with AppShark's SourceBody.
     * Supports 7 source kinds matching AppShark.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VulnSource(
        /** Return-type sources: list of method signature patterns (wildcards supported) */
        @JsonProperty("return") val returnSources: List<String>? = null,
        /** Param sources: method signature → list of param positions ("p0", "p1", "p*") */
        @JsonProperty("param") val paramSources: Map<String, List<String>>? = null,
        /** Static field sources: list of field signature patterns */
        @JsonProperty("static_field") val staticFieldSources: List<String>? = null,
        /** Instance field sources: list of field signature patterns */
        @JsonProperty("field") val fieldSources: List<String>? = null,
        /** New instance sources: list of class names */
        @JsonProperty("new_instance") val newInstanceSources: List<String>? = null,
        /** Constant string sources: list of glob patterns */
        @JsonProperty("const_string") val constStringSources: List<String>? = null,
        /** Use JS interface: all @JavascriptInterface method params are sources */
        @JsonProperty("use_js_interface") val useJSInterface: Boolean? = null
    )

    /**
     * Sink specification aligned with AppShark's SinkBody.
     * Keyed by method signature pattern.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VulnSink(
        @JsonProperty("taint_check") val taintCheck: List<String>? = null,
        @JsonProperty("not_taint") val notTaint: List<String>? = null,
        @JsonProperty("library_only") val libraryOnly: Boolean? = null,
        @JsonProperty("taint_param_type") val taintParamType: List<String>? = null
    )

    /**
     * Sanitizer body (same shape as VulnSink for taint_check).
     * Used inside the sanitizer map: { group_name: { method_sig: VulnSinkBody } }
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VulnSinkBody(
        @JsonProperty("taint_check") val taintCheck: List<String>? = null,
        @JsonProperty("not_taint") val notTaint: List<String>? = null,
        @JsonProperty("taint_param_type") val taintParamType: List<String>? = null
    )

    /**
     * Entry point specification aligned with AppShark's Entry.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VulnEntry(
        @JsonProperty("methods") val methods: List<String>? = null,
        @JsonProperty("components") val components: List<String>? = null,
        @JsonProperty("exported_compos") val exportedCompos: Boolean? = null
    )

    /**
     * Substitutes {{param}} placeholders in all method signatures.
     */
    fun resolveParams(params: Map<String, String>): VulnRule {
        if (params.isEmpty()) return this
        fun sub(s: String): String {
            var r = s
            params.forEach { (k, v) -> r = r.replace("{{$k}}", v) }
            return r
        }
        fun subList(l: List<String>?) = l?.map(::sub)
        fun subMapKeys(m: Map<String, List<String>>?) = m?.mapKeys { (k, _) -> sub(k) }?.mapValues { (_, v) -> v.map(::sub) }
        fun subSinkKeys(m: Map<String, VulnSink>?) = m?.mapKeys { (k, _) -> sub(k) }?.mapValues { (_, v) ->
            v.copy(taintCheck = subList(v.taintCheck), notTaint = subList(v.notTaint), taintParamType = v.taintParamType?.map(::sub))
        }
        fun subSanitizer(m: Map<String, Map<String, VulnSinkBody>>?) = m?.mapValues { (_, inner) ->
            inner.mapKeys { (k, _) -> sub(k) }.mapValues { (_, v) ->
                v.copy(taintCheck = subList(v.taintCheck), notTaint = subList(v.notTaint), taintParamType = v.taintParamType?.map(::sub))
            }
        }
        return copy(
            source = source?.copy(
                returnSources = subList(source.returnSources),
                paramSources = subMapKeys(source.paramSources),
                staticFieldSources = subList(source.staticFieldSources),
                fieldSources = subList(source.fieldSources),
                newInstanceSources = subList(source.newInstanceSources),
                constStringSources = subList(source.constStringSources)
            ),
            sink = subSinkKeys(sink),
            sanitizer = subSanitizer(sanitizer)
        )
    }
}
