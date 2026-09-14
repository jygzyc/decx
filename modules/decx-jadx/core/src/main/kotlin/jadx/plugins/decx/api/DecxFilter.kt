package jadx.plugins.decx.api

import java.util.regex.PatternSyntaxException

data class DecxFilter(
    val limit: Int? = null,
    val includes: List<String> = emptyList(),
    val excludes: List<String> = emptyList(),
    val caseSensitive: Boolean = false,
    val regex: Boolean = true
) {
    fun toQuery(): Map<String, Any> {
        return linkedMapOf<String, Any>().apply {
            limit?.let { put("limit", it) }
            if (includes.isNotEmpty()) put("includes", includes)
            if (excludes.isNotEmpty()) put("excludes", excludes)
            if (caseSensitive) put("caseSensitive", true)
            if (!regex) put("regex", false)
        }
    }

    fun compile(): Compiled? {
        fun build(patterns: List<String>): List<Matcher>? {
            return patterns.map { pattern -> matcher(pattern) ?: return null }
        }
        return Compiled(build(includes) ?: return null, build(excludes) ?: return null)
    }

    fun <T> limit(items: List<T>): List<T> {
        return limit?.let { items.take(it) } ?: items
    }

    private fun matcher(pattern: String): Matcher? {
        return if (regex) {
            try {
                Matcher.RegexMatcher(Regex(pattern))
            } catch (_: PatternSyntaxException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        } else {
            Matcher.LiteralMatcher(pattern)
        }
    }

    class Compiled internal constructor(
        private val includes: List<Matcher>,
        private val excludes: List<Matcher>
    ) {
        fun matches(value: String): Boolean {
            val included = includes.isEmpty() || includes.any { it.matches(value) }
            val excluded = excludes.any { it.matches(value) }
            return included && !excluded
        }
    }

    internal sealed interface Matcher {
        fun matches(value: String): Boolean

        data class LiteralMatcher(private val pattern: String) : Matcher {
            override fun matches(value: String): Boolean = value.contains(pattern)
        }

        data class RegexMatcher(private val pattern: Regex) : Matcher {
            override fun matches(value: String): Boolean = pattern.containsMatchIn(value)
        }
    }

    companion object {
        fun from(
            source: Map<*, *>?
        ): DecxFilter {
            if (source == null) return DecxFilter()
            return DecxFilter(
                limit = source.int("limit")?.coerceAtLeast(0),
                includes = source.strings("includes"),
                excludes = source.strings("excludes"),
                caseSensitive = source.boolean("caseSensitive") ?: false,
                regex = source.boolean("regex") ?: true
            )
        }

        private fun Map<*, *>.boolean(name: String): Boolean? {
            return when (val raw = this[name] ?: return null) {
                is Boolean -> raw
                is String -> when (raw.lowercase()) {
                    "true" -> true
                    "false" -> false
                    else -> throw IllegalArgumentException("Invalid parameter '$name': expected boolean")
                }
                else -> throw IllegalArgumentException("Invalid parameter '$name': expected boolean")
            }
        }

        private fun Map<*, *>.int(name: String): Int? {
            return when (val raw = this[name] ?: return null) {
                is Int -> raw
                is Long -> raw.toInt()
                is Double -> raw.toInt()
                is Float -> raw.toInt()
                is String -> raw.toIntOrNull() ?: throw IllegalArgumentException("Invalid parameter '$name': expected integer")
                else -> throw IllegalArgumentException("Invalid parameter '$name': expected integer")
            }
        }

        private fun Map<*, *>.strings(name: String): List<String> {
            return when (val raw = this[name] ?: return emptyList()) {
                is String -> listOf(raw).filter { it.isNotBlank() }
                is List<*> -> raw.map {
                    it as? String ?: throw IllegalArgumentException("Invalid parameter '$name': expected string array")
                }.filter { it.isNotBlank() }
                else -> throw IllegalArgumentException("Invalid parameter '$name': expected string array")
            }
        }
    }
}
