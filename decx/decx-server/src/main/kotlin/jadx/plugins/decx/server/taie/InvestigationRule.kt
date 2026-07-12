package jadx.plugins.decx.server.taie

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonSetter
import com.fasterxml.jackson.annotation.Nulls
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory
import java.io.File

/**
 * An investigation rule — a declarative "evidence collection instruction" that
 * tells the engine what targets to investigate and what evidence to gather.
 *
 * Rules do NOT contain source/sink/sanitizer semantics and do NOT make
 * vulnerability judgments. The engine collects structured evidence according
 * to the rule, and the AI (consuming DECX endpoints) performs the reasoning.
 *
 * YAML format:
 * ```yaml
 * id: investigate_intent_redirection
 * description: "Collect evidence for potential intent redirection"
 * category: intent_redirection
 * target_sdk: "26:34"
 * targets:
 *   - kind: method
 *     signature: "<android.os.BaseBundle: android.os.Parcelable getParcelable(java.lang.String)>"
 * collect:
 *   - kind: callers
 *     include_callees: true
 *   - kind: variable_flow
 *     variable: return
 *     depth: 10
 *   - kind: icc_targets
 *     from_callers_of: "<android.app.Activity: void startActivity(android.content.Intent)>"
 * context:
 *   - kind: dynamic_receivers
 *   - kind: callbacks
 *     component: exported
 * ```
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class InvestigationRule(
    @JsonProperty("id") val id: String? = "",
    @JsonProperty("description") val description: String? = "",
    @JsonProperty("category") val category: String? = "general",
    @JsonProperty("target_sdk") val targetSdk: String? = null,
    @JsonProperty("targets") val targets: List<TargetSpec>? = emptyList(),
    @JsonProperty("collect") val collect: List<CollectSpec>? = emptyList(),
    @JsonProperty("context") val context: List<ContextSpec>? = null
) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class TargetSpec(
        @JsonProperty("kind") val kind: String,        // "method" | "class" | "component"
        @JsonProperty("signature") val signature: String
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class CollectSpec(
        @JsonProperty("kind") val kind: String,        // "callers" | "callees" | "variable_flow" | "points_to" | "icc_targets" | "dynamic_receivers" | "callbacks"
        @JsonProperty("variable") val variable: String? = null,        // for variable_flow/points_to: "return" | "p0" | "this"
        @JsonProperty("depth") val depth: Int? = null,              // for variable_flow: trace depth
        @JsonProperty("include_callees") val includeCallees: Boolean = false,
        @JsonProperty("from_callers_of") val fromCallersOf: String? = null  // for icc_targets: filter by caller method
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class ContextSpec(
        @JsonProperty("kind") val kind: String,        // "dynamic_receivers" | "callbacks"
        @JsonProperty("component") val component: String? = null        // "exported" | "all" | explicit class name
    )
}

/**
 * Loads investigation rules from YAML files in a directory.
 * Each .yml/.yaml file may contain a single rule (mapping) or multiple rules
 * (a list of mappings).
 */
object RuleLoader {

    private val mapper = ObjectMapper(YAMLFactory()).apply {
        // Skip null values during deserialization so Kotlin default values are preserved
        setDefaultSetterInfo(JsonSetter.Value.forValueNulls(Nulls.SKIP))
    }

    /**
     * Loads all investigation rules from the given directory.
     *
     * @param rulesDir directory containing .yml/.yaml rule files
     * @return list of parsed [InvestigationRule]s, possibly empty
     */
    fun load(rulesDir: File): List<InvestigationRule> {
        if (!rulesDir.isDirectory) return emptyList()
        return rulesDir.listFiles()
            ?.filter { it.extension in listOf("yml", "yaml") }
            ?.sorted()
            ?.flatMap { loadFile(it) }
            ?: emptyList()
    }

    private fun loadFile(file: File): List<InvestigationRule> {
        return try {
            val content = file.readText()
            // Try parsing as a list first, then as a single rule
            val typeRef = object : com.fasterxml.jackson.core.type.TypeReference<List<InvestigationRule>>() {}
            try {
                mapper.readValue(content, typeRef)
            } catch (_: Exception) {
                listOf(mapper.readValue(content, InvestigationRule::class.java))
            }
        } catch (e: Exception) {
            System.err.println("[RuleLoader] Failed to parse ${file.name}: ${e.message}")
            emptyList()
        }
    }
}
