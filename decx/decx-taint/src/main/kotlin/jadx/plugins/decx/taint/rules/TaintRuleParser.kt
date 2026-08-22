package jadx.plugins.decx.taint.rules

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParseException
import jadx.plugins.decx.utils.LogUtils
import java.io.File
import java.util.jar.JarFile

/**
 * Parses and validates appshark-style JSON taint rules.
 *
 * Rule sources, in priority order:
 *  1. inline `rules` JSON string (request payload)
 *  2. `rulePath` directory (every `.json` file in it)
 *  3. built-in classpath rules under `taint/rules` (`.json` documents)
 *
 * Selection: `ruleNames` filters loaded rules by name; unknown names are an
 * error so callers cannot silently scan with fewer rules than requested.
 */
object TaintRuleParser {

    const val BUILTIN_DIR = "taint/rules"

    private val gson = Gson()

    // Tai-e/Jimple signature: <class: returnType name(paramTypes)>; method
    // names may be <init>/<clinit>, so the name segment allows angle brackets.
    private val SIGNATURE = Regex("^<[^:\\s>]+:\\s*[^:\\s>]+\\s+[^:\\s(]+\\([^)]*\\)>$")

    /** Parse one rule document (name -> body). */
    fun parseDocument(text: String, origin: String = TaintRule.ORIGIN_INLINE): List<TaintRule> {
        val root = try {
            gson.fromJson(text, JsonObject::class.java)
        } catch (e: JsonParseException) {
            throw IllegalArgumentException("Invalid rule JSON: ${e.message}", e)
        } ?: throw IllegalArgumentException("Invalid rule JSON: empty document")
        if (root.size() == 0) {
            throw IllegalArgumentException("Rule document contains no rules")
        }
        val rules = root.entrySet().map { (name, body) ->
            parseRule(name, body.asJsonObject, origin)
        }
        val duplicates = rules.groupBy { it.name }.filterValues { it.size > 1 }.keys
        if (duplicates.isNotEmpty()) {
            throw IllegalArgumentException("Duplicate rule names: ${duplicates.joinToString(", ")}")
        }
        return rules
    }

    /** Load every `*.json` rule document from a directory. */
    fun loadDir(dir: File): List<TaintRule> {
        if (!dir.isDirectory) {
            throw IllegalArgumentException("rulePath is not a directory: ${dir.absolutePath}")
        }
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }.orEmpty().sortedBy { it.name }
        if (files.isEmpty()) {
            throw IllegalArgumentException("rulePath contains no rule files: ${dir.absolutePath}")
        }
        return files.flatMap { file ->
            parseDocument(file.readText(), origin = file.absolutePath)
        }
    }

    /** Built-in rules shipped on the classpath (jar or exploded classes). */
    fun loadBuiltin(): List<TaintRule> {
        val names = mutableSetOf<String>()
        try {
            val loader = TaintRuleParser::class.java.classLoader
            val urls = loader.getResources(BUILTIN_DIR).toList()
            for (url in urls) {
                when (url.protocol) {
                    "jar" -> {
                        val fileUrl = url.toString().removePrefix("jar:").substringBefore("!/")
                        val jarFile = File(java.net.URI(fileUrl))
                        JarFile(jarFile).use { jar ->
                            jar.entries().asSequence()
                                .filter { it.name.startsWith("$BUILTIN_DIR/") && it.name.endsWith(".json") }
                                .forEach { names.add(it.name.removePrefix("$BUILTIN_DIR/").removeSuffix(".json")) }
                        }
                    }
                    "file" -> {
                        File(url.toURI()).listFiles { f -> f.name.endsWith(".json") }
                            ?.forEach { names.add(it.name.removeSuffix(".json")) }
                    }
                }
            }
        } catch (e: Exception) {
            LogUtils.warn("Failed to list built-in taint rules: ${e.message}")
            return emptyList()
        }
        return names.sorted().flatMap { name ->
            val resource = TaintRuleParser::class.java.getResourceAsStream("/$BUILTIN_DIR/$name.json")
            if (resource == null) emptyList() else parseDocument(resource.bufferedReader().use { it.readText() }, TaintRule.ORIGIN_BUILTIN)
        }
    }

    /** Filter rules by name; unknown names are an error. */
    fun select(rules: List<TaintRule>, names: List<String>): List<TaintRule> {
        if (names.isEmpty()) return rules
        val byName = rules.associateBy { it.name }
        val missing = names.filter { it !in byName }
        if (missing.isNotEmpty()) {
            throw IllegalArgumentException("Unknown rule names: ${missing.joinToString(", ")}")
        }
        return names.mapNotNull { byName[it] }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private fun parseRule(name: String, body: JsonObject, origin: String): TaintRule {
        if (name.isBlank()) throw IllegalArgumentException("Rule name cannot be blank")
        val severity = body.stringOrNull("severity")?.lowercase() ?: TaintRule.SEVERITY_MEDIUM
        if (severity !in TaintRule.SEVERITIES) {
            throw IllegalArgumentException("Rule '$name': unknown severity '$severity' (${TaintRule.SEVERITIES.joinToString("|")})")
        }
        val sources = body.entries("sources")?.map { parseEntry(it, name, "sources") }
            ?: throw IllegalArgumentException("Rule '$name': sources is required")
        val sinks = body.entries("sinks")?.map { parseEntry(it, name, "sinks") }
            ?: throw IllegalArgumentException("Rule '$name': sinks is required")
        if (sources.isEmpty()) throw IllegalArgumentException("Rule '$name': sources cannot be empty")
        if (sinks.isEmpty()) throw IllegalArgumentException("Rule '$name': sinks cannot be empty")
        val transfers = body.entries("transfers")?.map { parseTransfer(it, name) } ?: emptyList()
        val sanitizers = body.entries("sanitizers")?.map { parseEntry(it, name, "sanitizers") } ?: emptyList()
        return TaintRule(
            name = name,
            description = body.stringOrNull("description") ?: "",
            category = body.stringOrNull("category") ?: "",
            severity = severity,
            sources = sources,
            sinks = sinks,
            transfers = transfers,
            sanitizers = sanitizers,
            origin = origin
        )
    }

    private fun parseEntry(element: com.google.gson.JsonElement, ruleName: String, section: String): RuleEntry {
        val obj = element.asJsonObject ?: run {
            throw IllegalArgumentException("Rule '$ruleName': $section entries must be objects")
        }
        val method = obj.stringOrNull("method")
            ?: throw IllegalArgumentException("Rule '$ruleName': $section entry is missing 'method'")
        validateSignature(method, ruleName, section)
        val index = obj.indexOrNull("index")
            ?: throw IllegalArgumentException("Rule '$ruleName': $section entry is missing 'index'")
        validatePosition(index, ruleName, section, "index")
        return RuleEntry(method = method, index = index)
    }

    private fun parseTransfer(element: com.google.gson.JsonElement, ruleName: String): RuleTransfer {
        val obj = element.asJsonObject
            ?: throw IllegalArgumentException("Rule '$ruleName': transfers entries must be objects")
        val method = obj.stringOrNull("method")
            ?: throw IllegalArgumentException("Rule '$ruleName': transfers entry is missing 'method'")
        validateSignature(method, ruleName, "transfers")
        val from = obj.indexOrNull("from")
            ?: throw IllegalArgumentException("Rule '$ruleName': transfers entry is missing 'from'")
        val to = obj.indexOrNull("to")
            ?: throw IllegalArgumentException("Rule '$ruleName': transfers entry is missing 'to'")
        validatePosition(from, ruleName, "transfers", "from")
        validatePosition(to, ruleName, "transfers", "to")
        return RuleTransfer(method = method, from = from, to = to)
    }

    private fun validateSignature(method: String, ruleName: String, section: String) {
        if (!SIGNATURE.matches(method)) {
            throw IllegalArgumentException(
                "Rule '$ruleName': $section method signature must be '<class: returnType name(paramTypes)>', got: $method"
            )
        }
    }

    private fun validatePosition(position: String, ruleName: String, section: String, field: String) {
        if (position == "result" || position == "base") return
        if (position.toIntOrNull()?.let { it >= 0 } == true) return
        throw IllegalArgumentException(
            "Rule '$ruleName': $section $field must be 'result', 'base', or a 0-based integer, got: '$position'"
        )
    }

    private fun JsonObject.stringOrNull(name: String): String? {
        val element = get(name) ?: return null
        if (element.isJsonNull) return null
        if (!element.isJsonPrimitive) {
            throw IllegalArgumentException("Field '$name' must be a string")
        }
        return element.asString
    }

    /** Coerces "result"/"base" and numeric positions (JSON `1` or `"1"`) to a string. */
    private fun JsonObject.indexOrNull(name: String): String? {
        val element = get(name) ?: return null
        if (element.isJsonNull) return null
        if (!element.isJsonPrimitive) return null
        return if (element.asJsonPrimitive.isNumber) {
            // Gson parses JSON integers as Double; normalize 1.0 -> "1".
            val d = element.asDouble
            if (d % 1.0 == 0.0) d.toLong().toString() else d.toString()
        } else {
            element.asString
        }
    }

    private fun JsonObject.entries(name: String): List<com.google.gson.JsonElement>? {
        val element = get(name) ?: return null
        if (element.isJsonNull) return null
        if (!element.isJsonArray) {
            throw IllegalArgumentException("Field '$name' must be an array")
        }
        return element.asJsonArray.toList()
    }
}
