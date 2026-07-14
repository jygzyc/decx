package decx.taie

import pascal.taie.analysis.pta.plugin.taint.CallSource
import pascal.taie.analysis.pta.plugin.taint.FieldSource
import pascal.taie.analysis.pta.plugin.taint.IndexRef
import pascal.taie.analysis.pta.plugin.taint.ParamSanitizer
import pascal.taie.analysis.pta.plugin.taint.Sink
import pascal.taie.analysis.pta.plugin.taint.Source
import pascal.taie.analysis.pta.plugin.taint.TaintConfigProvider
import pascal.taie.analysis.pta.plugin.taint.TaintFlow
import pascal.taie.analysis.pta.plugin.taint.TaintTransfer
import pascal.taie.analysis.pta.plugin.util.InvokeUtils
import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JField
import pascal.taie.language.classes.JMethod
import pascal.taie.language.type.TypeSystem

/**
 * Converts AppShark-style VulnRules into Tai-e TaintConfig (Source/Sink/Sanitizer/Transfer).
 *
 * Tai-e instantiates this class reflectively via the `taint-config-providers`
 * PTA option. The constructor signature must match (ClassHierarchy, TypeSystem).
 *
 * Rules are loaded from companion static fields:
 * - [presetRules]: loaded at engine init from ~/.decx/rules/
 * - [customRule]: set temporarily for investigateCustom API
 */
class DecxTaintConfigProvider(
    hierarchy: ClassHierarchy,
    typeSystem: TypeSystem
) : TaintConfigProvider(hierarchy, typeSystem) {

    init {
        // Clear stale state from previous PTA runs
        methodToRule.clear()
        sinkToRule.clear()
    }

    override fun sources(): List<Source> {
        val rules = activeRules()
        System.err.println("[DecxTaintProvider] sources() called, ${rules.size} active rule(s)")
        val sources = mutableListOf<Source>()

        for (rule in rules) {
            val src = rule.source ?: continue

            // 1. return sources
            src.returnSources?.forEach { pattern ->
                val methods = MethodFinder.resolveMethods(pattern, hierarchy)
                System.err.println("[DecxTaintProvider]   source 'return' '$pattern' -> ${methods.size}")
                for (m in methods) {
                    sources.add(CallSource(m,
                        IndexRef(IndexRef.Kind.VAR, InvokeUtils.RESULT, null),
                        m.returnType))
                    methodToRule[m] = rule.id ?: "unknown"
                }
            }

            // 2. param sources
            src.paramSources?.forEach { (pattern, positions) ->
                val methods = MethodFinder.resolveMethods(pattern, hierarchy)
                System.err.println("[DecxTaintProvider]   source 'param' '$pattern' positions=$positions -> ${methods.size}")
                for (m in methods) {
                    for (pos in positions) {
                        val idx = parsePosition(pos, m)
                        if (idx >= 0 && idx < m.paramCount) {
                            sources.add(CallSource(m,
                                IndexRef(IndexRef.Kind.VAR, idx, null),
                                m.getParamType(idx)))
                            methodToRule[m] = rule.id ?: "unknown"
                        }
                    }
                }
            }

            // 3. static field / field sources
            val fieldPatterns = (src.staticFieldSources ?: emptyList()) + (src.fieldSources ?: emptyList())
            fieldPatterns.forEach { pattern ->
                val fields = resolveFields(pattern, hierarchy)
                System.err.println("[DecxTaintProvider]   source 'field' '$pattern' -> ${fields.size}")
                for (f in fields) {
                    sources.add(FieldSource(f, f.type))
                }
            }

            // 4. new_instance sources — handled via Plugin onStart (not CallSource)
            src.newInstanceSources?.forEach { className ->
                System.err.println("[DecxTaintProvider]   source 'new_instance' '$className' (handled via plugin)")
            }

            // 5. const_string sources — handled via Plugin onStart
            src.constStringSources?.forEach { pattern ->
                System.err.println("[DecxTaintProvider]   source 'const_string' '$pattern' (handled via plugin)")
            }

            // 6. useJSInterface — handled via Plugin onStart
            if (src.useJSInterface == true) {
                System.err.println("[DecxTaintProvider]   source 'useJSInterface' (handled via plugin)")
            }
        }

        return sources
    }

    override fun sinks(): List<Sink> {
        val rules = activeRules()
        System.err.println("[DecxTaintProvider] sinks() called, ${rules.size} active rule(s)")
        val sinks = mutableListOf<Sink>()

        for (rule in rules) {
            rule.sink?.forEach { (pattern, sinkSpec) ->
                val methods = MethodFinder.resolveMethods(pattern, hierarchy)
                val checks = sinkSpec.taintCheck ?: listOf("p0")
                System.err.println("[DecxTaintProvider]   sink '$pattern' taint_check=$checks -> ${methods.size}")

                for (m in methods) {
                    // Expand each taint_check position to a sink
                    for (check in checks) {
                        val indices = expandPosition(check, m)
                        for (idx in indices) {
                            sinks.add(Sink(m, IndexRef(IndexRef.Kind.VAR, idx, null)))
                            // Track sink→rule mapping with FULL signature to avoid collisions
                            sinkToRule["${TaiESignatures.toDecxMethodId(m)}:$idx"] = rule.id ?: "unknown"
                        }
                    }
                }
            }
        }

        return sinks
    }

    override fun sanitizers(): List<ParamSanitizer> {
        val rules = activeRules()
        val sanitizers = mutableListOf<ParamSanitizer>()

        for (rule in rules) {
            rule.sanitizer?.forEach { (groupName, methods) ->
                // Each group is an OR unit; within a group, methods are AND'd
                methods.forEach { (pattern, body) ->
                    val resolvedMethods = MethodFinder.resolveMethods(pattern, hierarchy)
                    val checks = body.taintCheck ?: listOf("p0")
                    for (m in resolvedMethods) {
                        for (check in checks) {
                            val indices = expandPosition(check, m)
                            for (idx in indices) {
                                sanitizers.add(ParamSanitizer(m, idx))
                            }
                        }
                    }
                }
            }
        }

        return sanitizers
    }

    override fun transfers(): List<TaintTransfer> {
        return DecxTaintTransfer.getTransfers(hierarchy, typeSystem)
    }

    override fun callSiteMode(): Boolean = false

    // ------------------------------------------------------------------
    // Position parsing (AppShark taint position vocabulary)
    // ------------------------------------------------------------------

    /**
     * Parses a single position string to a Tai-e index.
     * Does NOT handle p* — use [expandPosition] for that.
     */
    private fun parsePosition(pos: String, method: JMethod): Int {
        return when {
            pos == "p*" -> 0 // p* handled by expandPosition
            pos == "@this" -> InvokeUtils.BASE
            pos == "return" || pos == "ret" -> InvokeUtils.RESULT
            pos.startsWith("p") -> pos.removePrefix("p").toIntOrNull() ?: 0
            else -> 0
        }
    }

    /**
     * Expands a taint_check position to a list of concrete indices.
     * "p*" expands to all parameter indices.
     * "@this" → BASE, "return" → RESULT, "p0".."pN" → N.
     */
    private fun expandPosition(pos: String, method: JMethod): List<Int> {
        return when {
            pos == "p*" -> (0 until method.paramCount).toList()
            pos == "@this" -> listOf(InvokeUtils.BASE)
            pos == "return" || pos == "ret" -> listOf(InvokeUtils.RESULT)
            pos.startsWith("p") -> {
                val idx = pos.removePrefix("p").toIntOrNull()
                if (idx != null && idx >= 0 && idx < method.paramCount) listOf(idx) else emptyList()
            }
            else -> listOf(0)
        }
    }

    /**
     * Resolves a field signature pattern to concrete JFields.
     * Pattern: <ClassName: FieldType FieldName>
     */
    private fun resolveFields(pattern: String, hierarchy: ClassHierarchy): List<JField> {
        // Parse: <ClassName: FieldType FieldName>
        val inner = pattern.removePrefix("<").removeSuffix(">").trim()
        val colonIdx = inner.indexOf(':')
        if (colonIdx < 0) return emptyList()
        val className = inner.substring(0, colonIdx).trim()
        val rest = inner.substring(colonIdx + 1).trim()
        val spaceIdx = rest.lastIndexOf(' ')
        if (spaceIdx < 0) return emptyList()
        val fieldType = rest.substring(0, spaceIdx).trim()
        val fieldName = rest.substring(spaceIdx + 1).trim()

        val cls = hierarchy.getClass(className) ?: return emptyList()
        val field = cls.getDeclaredField(fieldName) ?: return emptyList()
        return listOf(field)
    }

    companion object {
        @Volatile var presetRules: List<VulnRule> = emptyList()
        @Volatile var customRule: VulnRule? = null

        private val methodToRule = mutableMapOf<JMethod, String>()
        private val sinkToRule = mutableMapOf<String, String>()

        fun activeRules(): List<VulnRule> {
            val rules = presetRules.toMutableList()
            customRule?.let { rules.add(it) }
            return rules
        }

        /**
         * Attempts to match a TaintFlow to a rule ID by checking sink signatures.
         */
        fun matchFlowToRule(flow: TaintFlow): String? {
            val flowStr = flow.toString()
            for ((key, ruleId) in sinkToRule) {
                if (flowStr.contains(key)) return ruleId
            }
            return null
        }
    }
}
