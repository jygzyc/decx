package jadx.plugins.decx.taint.config

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory
import com.fasterxml.jackson.module.kotlin.KotlinModule
import jadx.plugins.decx.utils.LogUtils

/**
 * Resolves user-supplied taint config YAML into a [TaintConfig].
 *
 * Resolution rules:
 *  1. Parse the user YAML into a generic map.
 *  2. If `preset` is present, load the matching built-in preset from the
 *     classpath (`taint/templates/<name>.yml`) and use it as the base.
 *  3. Deep-merge the user map over the base: user fields win, non-map values
 *     replace, maps merge recursively. `preset` itself is dropped from the
 *     merged map.
 *  4. Convert the merged map into a [TaintConfig]; `raw` is preserved verbatim.
 *
 * `preset` is an engine-agnostic concept: a preset is just a TaintConfig
 * fragment (analysis/limits/taint). New engines can ship their own presets.
 */
object TaintConfigParser {

    const val PRESET_DIR = "taint/templates"
    const val FIELD_PRESET = "preset"

    private val mapper: ObjectMapper = ObjectMapper(YAMLFactory())
        .registerModule(KotlinModule.Builder().build())

    /**
     * Resolve a user config YAML (string) into a [TaintConfig].
     *
     * @throws IllegalArgumentException when the YAML is invalid, the preset is
     *         unknown, or the resolved config is incomplete.
     */
    fun resolve(userYaml: String): TaintConfig {
        val user = parseMap(userYaml)
        return resolveMap(user)
    }

    /**
     * Resolve a user config already parsed into a map (used by MCP adapter).
     */
    fun resolveMap(user: Map<String, Any>): TaintConfig {
        val presetName = user[FIELD_PRESET]?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val base: Map<String, Any> = if (presetName != null) loadPreset(presetName) else emptyMap()
        val merged = deepMerge(base, user)
        // Drop meta fields: preset selector + preset metadata (name/description).
        merged.remove(FIELD_PRESET)
        merged.remove("name")
        merged.remove("description")
        val config = try {
            mapper.convertValue(merged, TaintConfig::class.java)
        } catch (e: Exception) {
            throw IllegalArgumentException("Invalid taint config: ${e.message}", e)
        }
        validate(config)
        return config
    }

    /** Names + descriptions of all built-in presets (for /taint/templates). */
    fun listPresets(): List<Map<String, Any>> {
        val names = mutableSetOf<String>()
        try {
            val loader = TaintConfigParser::class.java.classLoader
            val urls = loader.getResources(PRESET_DIR).toList()
            for (url in urls) {
                when (url.protocol) {
                    "jar" -> {
                        val fileUrl = url.toString().removePrefix("jar:").substringBefore("!/")
                        val jarFile = java.io.File(java.net.URI(fileUrl))
                        java.util.jar.JarFile(jarFile).use { jar ->
                            jar.entries().asSequence()
                                .filter { it.name.startsWith("$PRESET_DIR/") && it.name.endsWith(".yml") }
                                .forEach { names.add(it.name.removePrefix("$PRESET_DIR/").removeSuffix(".yml")) }
                        }
                    }
                    "file" -> {
                        java.io.File(url.toURI()).listFiles { f -> f.name.endsWith(".yml") }
                            ?.forEach { names.add(it.name.removeSuffix(".yml")) }
                    }
                }
            }
        } catch (e: Exception) {
            LogUtils.warn("Failed to list taint presets: ${e.message}")
            return emptyList()
        }
        return names.sorted().mapNotNull { name ->
            runCatching {
                val preset = loadPreset(name)
                linkedMapOf<String, Any>(
                    "name" to (preset["name"]?.toString() ?: name),
                    "description" to (preset["description"]?.toString() ?: "")
                )
            }.getOrNull()
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private fun parseMap(yaml: String): Map<String, Any> {
        if (yaml.isBlank()) return emptyMap()
        return try {
            val raw = mapper.readValue(yaml, Any::class.java)
            when (raw) {
                is Map<*, *> -> raw.entries.associate { (k, v) -> k.toString() to normalize(v) }
                else -> throw IllegalArgumentException("Taint config must be a YAML mapping")
            }
        } catch (e: com.fasterxml.jackson.core.JacksonException) {
            throw IllegalArgumentException("Invalid taint config YAML: ${e.message}", e)
        }
    }

    private fun normalize(value: Any?): Any = when (value) {
        is Map<*, *> -> value.entries.associate { (k, v) -> k.toString() to normalize(v) }
        is List<*> -> value.map { normalize(it) }
        else -> value ?: ""
    }

    private fun loadPreset(name: String): Map<String, Any> {
        val resource = "/$PRESET_DIR/$name.yml"
        val stream = TaintConfigParser::class.java.getResourceAsStream(resource)
            ?: throw IllegalArgumentException("Unknown taint preset: '$name'")
        return stream.bufferedReader().use { parseMap(it.readText()) }
    }

    /** Recursive deep merge: user wins, maps merge, everything else replaces. */
    private fun deepMerge(base: Map<String, Any>, user: Map<String, Any>): MutableMap<String, Any> {
        val merged = LinkedHashMap(base)
        for ((key, userValue) in user) {
            val baseValue = merged[key]
            merged[key] = when {
                baseValue is Map<*, *> && userValue is Map<*, *> -> {
                    deepMerge(
                        baseValue.entries.associate { (k, v) -> k.toString() to normalize(v) },
                        userValue.entries.associate { (k, v) -> k.toString() to normalize(v) }
                    )
                }
                else -> userValue
            }
        }
        return merged
    }

    private fun validate(config: TaintConfig) {
        config.target.resolveTarget()
        if (config.taint.isEmpty && config.raw?.containsKey("taint-config") != true) {
            throw IllegalArgumentException(
                "Taint config has no sources/sinks: reference a preset, define taint rules, " +
                    "or pass taint-config via raw"
            )
        }
        val algorithm = config.analysis.algorithm
        if (algorithm !in setOf("pta", "cha")) {
            throw IllegalArgumentException("Unknown analysis.algorithm: '$algorithm' (pta | cha)")
        }
    }
}
