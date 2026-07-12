package decx.taie

import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JClass
import pascal.taie.language.classes.JMethod

/**
 * Resolves wildcard method signature patterns to concrete JMethods.
 *
 * Patterns follow AppShark conventions:
 * - `*` in class position: matches all classes
 * - `*` in method name: prefix/suffix/contains matching (case-insensitive)
 * - `*` in arg list: `(*)` matches any args
 * - When class name is explicit, automatically includes subclass overrides
 *
 * Pattern format: `<ClassName: ReturnType MethodName(ArgTypes)>`
 * Example: `<android.app.Activity: void startActivity*(*)>`
 */
object MethodFinder {

    data class PatternParts(
        val className: String,
        val returnType: String,
        val methodName: String,
        val argTypes: String
    )

    /**
     * Parses a Tai-e-style signature pattern into its component parts.
     * Input: `<com.example.Foo: boolean bar(int,java.lang.String)>`
     */
    fun parse(pattern: String): PatternParts? {
        // Strip angle brackets
        val inner = pattern.removePrefix("<").removeSuffix(">").trim()
        val colonIdx = inner.indexOf(':')
        if (colonIdx < 0) return null

        val className = inner.substring(0, colonIdx).trim()
        val rest = inner.substring(colonIdx + 1).trim()

        val parenIdx = rest.indexOf('(')
        if (parenIdx < 0) return null

        val beforeParen = rest.substring(0, parenIdx).trim()
        val args = rest.substring(parenIdx) // includes parens

        // Split "ReturnType MethodName" at the last space
        val spaceIdx = beforeParen.lastIndexOf(' ')
        if (spaceIdx < 0) return null

        val returnType = beforeParen.substring(0, spaceIdx).trim()
        val methodName = beforeParen.substring(spaceIdx + 1).trim()

        return PatternParts(className, returnType, methodName, args)
    }

    /**
     * Resolves a pattern to all matching JMethods in the hierarchy.
     * If the class name is explicit (no wildcard), includes subclass overrides.
     */
    fun resolveMethods(pattern: String, hierarchy: ClassHierarchy): List<JMethod> {
        val parts = parse(pattern) ?: return emptyList()
        val results = mutableListOf<JMethod>()

        val targetClasses = if (parts.className == "*") {
            hierarchy.allClasses().toList()
        } else {
            // Explicit class: include the class itself + all subclasses
            val baseClass = hierarchy.getClass(parts.className)
            if (baseClass != null) {
                listOf(baseClass) + hierarchy.getAllSubclassesOf(baseClass)
            } else {
                emptyList()
            }
        }

        for (cls in targetClasses) {
            for (method in cls.declaredMethods) {
                if (matchesMethod(method, parts)) {
                    results.add(method)
                }
            }
        }

        return results.distinct()
    }

    private fun matchesMethod(method: JMethod, parts: PatternParts): Boolean {
        // Method name: wildcard or exact (case-insensitive)
        if (!matchWildcard(method.name, parts.methodName)) return false

        // Return type: wildcard or match
        if (parts.returnType != "*" && parts.returnType != "*") {
            if (!matchWildcard(method.returnType.toString(), parts.returnType)) return false
        }

        // Arg types: "(*)" matches any; otherwise match count/type loosely
        if (parts.argTypes == "(*)") return true
        if (parts.argTypes == "()") return method.paramCount == 0

        // For specific args, do a loose match on param count
        val patternArgs = parts.argTypes.removePrefix("(").removeSuffix(")")
        if (patternArgs.isBlank()) return method.paramCount == 0
        val patternArgCount = patternArgs.split(",").size
        return method.paramCount == patternArgCount
    }

    /**
     * Matches a value against a wildcard pattern.
     * Supports: `*` (any), `prefix*`, `*suffix`, `*contains*`, exact (case-insensitive).
     */
    private fun matchWildcard(value: String, pattern: String): Boolean {
        if (pattern == "*") return true
        val v = value.lowercase()
        val p = pattern.lowercase()
        return when {
            p.startsWith("*") && p.endsWith("*") -> v.contains(p.substring(1, p.length - 1))
            p.startsWith("*") -> v.endsWith(p.substring(1))
            p.endsWith("*") -> v.startsWith(p.substring(0, p.length - 1))
            else -> v == p
        }
    }
}
