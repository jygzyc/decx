package decx.taie

import pascal.taie.analysis.pta.plugin.taint.CallSource
import pascal.taie.analysis.pta.plugin.taint.IndexRef
import pascal.taie.analysis.pta.plugin.taint.ParamSanitizer
import pascal.taie.analysis.pta.plugin.taint.Sink
import pascal.taie.analysis.pta.plugin.taint.Source
import pascal.taie.analysis.pta.plugin.taint.TaintConfigProvider
import pascal.taie.analysis.pta.plugin.taint.TaintFlow
import pascal.taie.analysis.pta.plugin.util.InvokeUtils
import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JMethod
import pascal.taie.language.type.ClassType
import pascal.taie.language.type.TypeSystem

/**
 * Converts AppShark-style VulnRules into Tai-e TaintConfig (Source/Sink).
 *
 * Tai-e instantiates this class reflectively via the `taint-config-providers`
 * PTA option. The constructor signature must match
 * `(ClassHierarchy, TypeSystem)`.
 *
 * Rules are loaded from [companion] static fields:
 * - [presetRules]: loaded at engine init from ~/.decx/rules/
 * - [customRule]: set temporarily for investigateCustom API
 *
 * After PTA completes, [matchFlowToRule] maps each TaintFlow back to its
 * originating rule ID for per-rule result grouping.
 */
class DecxTaintConfigProvider(
    hierarchy: ClassHierarchy,
    typeSystem: TypeSystem
) : TaintConfigProvider(hierarchy, typeSystem) {

    override fun sources(): List<Source> {
        val rules = activeRules()
        System.err.println("[DecxTaintProvider] sources() called, ${rules.size} active rule(s)")
        val sources = mutableListOf<Source>()
        for (rule in rules) {
            for (spec in rule.source.orEmpty()) {
                val methods = MethodFinder.resolveMethods(spec.method, hierarchy)
                System.err.println("[DecxTaintProvider]   source '${spec.kind}' pattern '${spec.method}' -> ${methods.size} method(s)")
                for (method in methods) {
                    when (spec.kind) {
                        "return" -> {
                            sources.add(CallSource(method,
                                IndexRef(IndexRef.Kind.VAR, InvokeUtils.RESULT, null),
                                method.returnType))
                        }
                        "param" -> {
                            val pos = spec.position?.let { parsePosition(it) } ?: 0
                            if (pos >= 0 && pos < method.paramCount) {
                                sources.add(CallSource(method,
                                    IndexRef(IndexRef.Kind.VAR, pos, null),
                                    method.getParamType(pos)))
                            }
                        }
                        "field" -> {
                            // Approximate field source as return-type source
                            sources.add(CallSource(method,
                                IndexRef(IndexRef.Kind.VAR, InvokeUtils.RESULT, null),
                                method.returnType))
                        }
                    }
                }
                methods.forEach { methodToRule[it] = rule.id ?: "unknown" }
            }
        }
        return sources
    }

    override fun sinks(): List<Sink> {
        val rules = activeRules()
        System.err.println("[DecxTaintProvider] sinks() called, ${rules.size} active rule(s)")
        val sinks = mutableListOf<Sink>()
        for (rule in rules) {
            for (spec in rule.sink.orEmpty()) {
                val methods = MethodFinder.resolveMethods(spec.method, hierarchy)
                System.err.println("[DecxTaintProvider]   sink pattern '${spec.method}' taint_check=${spec.taintCheck} -> ${methods.size} method(s)")
                for (m in methods) {
                    for (taintCheck in spec.taintCheck) {
                        val index = parsePosition(taintCheck)
                        if (index >= 0 && index < m.paramCount) {
                            sinks.add(Sink(m, IndexRef(IndexRef.Kind.VAR, index, null)))
                            sinkToRule["${m.name}:$index"] = rule.id ?: "unknown"
                        }
                    }
                }
            }
        }
        return sinks
    }

    override fun callSiteMode(): Boolean = false

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
         * Attempts to match a TaintFlow to a rule ID.
         * SourcePoint/SinkPoint are package-private, so we use toString() only.
         */
        fun matchFlowToRule(flow: TaintFlow): String? {
            val flowStr = flow.toString()
            for ((key, ruleId) in sinkToRule) {
                if (flowStr.contains(key)) return ruleId
            }
            // Can't access sourcePoint.container (package-private),
            // so fallback to string matching
            return null
        }

        private fun parsePosition(pos: String): Int {
            return when {
                pos == "p*" -> 0
                pos == "@this" -> InvokeUtils.BASE
                pos == "result" || pos == "ret" -> InvokeUtils.RESULT
                pos.startsWith("p") -> pos.removePrefix("p").toIntOrNull() ?: 0
                else -> 0
            }
        }
    }
}
