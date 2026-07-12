package decx.taie

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory
import java.io.File

/**
 * Loads AppShark-style taint rules from YAML files or inline YAML strings.
 *
 * Used in two contexts:
 * 1. At TaiEEngine startup: loads all .yml files from `~/.decx/rules/`
 * 2. For the `investigateCustom` API: parses an inline YAML string provided by AI
 */
object RuleLoader {

    private val mapper = ObjectMapper(YAMLFactory())

    /**
     * Loads all rules from the given directory.
     * Each .yml/.yaml file should contain a single rule mapping.
     */
    fun load(rulesDir: File): List<VulnRule> {
        if (!rulesDir.isDirectory) return emptyList()
        return rulesDir.listFiles()
            ?.filter { it.extension in listOf("yml", "yaml") }
            ?.sorted()
            ?.mapNotNull { loadFile(it) }
            ?: emptyList()
    }

    /**
     * Parses a single rule from a YAML string.
     * Used by the `investigateCustom` API for AI-provided inline rules.
     */
    fun parseYaml(yamlString: String): VulnRule? {
        return try {
            mapper.readValue(yamlString, VulnRule::class.java)
        } catch (e: Exception) {
            System.err.println("[RuleLoader] Failed to parse inline rule: ${e.message}")
            null
        }
    }

    private fun loadFile(file: File): VulnRule? {
        return try {
            mapper.readValue(file.readText(), VulnRule::class.java)
        } catch (e: Exception) {
            System.err.println("[RuleLoader] Failed to parse ${file.name}: ${e.message}")
            null
        }
    }
}
