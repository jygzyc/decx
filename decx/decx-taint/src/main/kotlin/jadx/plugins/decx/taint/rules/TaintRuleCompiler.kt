package jadx.plugins.decx.taint.rules

/**
 * Compiles a set of rules into the single taint fragment handed to the Tai-e
 * worker, plus the attribution tables used to map reported flows back to
 * rules. All selected rules run in ONE analysis pass (one Tai-e world build)
 * instead of one pass per rule.
 */
object TaintRuleCompiler {

    /** Result of compiling a rule set. */
    data class CompiledRules(
        val rules: List<TaintRule>,
        /** Tai-e taint-config fragment: callSiteMode + sources/sinks/transfers/sanitizers. */
        val taintFragment: Map<String, Any>
    ) {
        /**
         * Which rules explain a flow with the given source/sink method
         * signatures. A rule matches when it declares both the source method
         * and the sink method. When no single rule covers the pair (taint ran
         * from rule A's source into rule B's sink), every rule contributing
         * either side is returned with [Attribution.crossRule] set.
         */
        fun attribute(sourceMethod: String, sinkMethod: String): Attribution {
            val matching = rules.filter { rule ->
                rule.sources.any { it.method == sourceMethod } && rule.sinks.any { it.method == sinkMethod }
            }
            if (matching.isNotEmpty()) return Attribution(matching, crossRule = false)
            val sourceSide = rules.filter { rule -> rule.sources.any { it.method == sourceMethod } }
            val sinkSide = rules.filter { rule -> rule.sinks.any { it.method == sinkMethod } }
            return Attribution((sourceSide + sinkSide).distinctBy { it.name }, crossRule = true)
        }
    }

    data class Attribution(val rules: List<TaintRule>, val crossRule: Boolean)

    fun compile(rules: List<TaintRule>): CompiledRules {
        if (rules.isEmpty()) throw IllegalArgumentException("No taint rules selected")
        val sources = rules.flatMap { it.sources }.distinctBy { it.method to it.index }
        val sinks = rules.flatMap { it.sinks }.distinctBy { it.method to it.index }
        val transfers = rules.flatMap { it.transfers }.distinctBy { Triple(it.method, it.from, it.to) }
        val sanitizers = rules.flatMap { it.sanitizers }.distinctBy { it.method to it.index }
        if (sources.isEmpty() || sinks.isEmpty()) {
            throw IllegalArgumentException("Compiled rule set has no sources or no sinks")
        }
        return CompiledRules(
            rules = rules,
            taintFragment = linkedMapOf(
                "callSiteMode" to true,
                "sources" to sources.map { linkedMapOf<String, Any>("method" to it.method, "index" to it.index) },
                "sinks" to sinks.map { linkedMapOf<String, Any>("method" to it.method, "index" to it.index) },
                "transfers" to transfers.map {
                    linkedMapOf<String, Any>("method" to it.method, "from" to it.from, "to" to it.to)
                },
                "sanitizers" to sanitizers.map { linkedMapOf<String, Any>("method" to it.method, "index" to it.index) }
            )
        )
    }
}
