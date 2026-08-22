package jadx.plugins.decx.taint.rules

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class TaintRuleCompilerTest {

    private fun rule(
        name: String,
        sources: List<String>,
        sinks: List<String>,
        severity: String = "medium"
    ): TaintRule = TaintRule(
        name = name,
        severity = severity,
        sources = sources.map { RuleEntry(it, "result") },
        sinks = sinks.map { RuleEntry(it, "0") }
    )

    private val srcA = "<a.Src: java.lang.String srcA()>"
    private val srcB = "<a.Src: java.lang.String srcB()>"
    private val sinkX = "<a.Sink: void sinkX(java.lang.String)>"
    private val sinkY = "<a.Sink: void sinkY(java.lang.String)>"

    @Test
    fun `compile dedups entries shared across rules`() {
        val compiled = TaintRuleCompiler.compile(
            listOf(
                rule("r1", listOf(srcA), listOf(sinkX)),
                rule("r2", listOf(srcA, srcB), listOf(sinkX, sinkY))
            )
        )
        @Suppress("UNCHECKED_CAST")
        val sources = compiled.taintFragment["sources"] as List<Map<String, Any>>
        @Suppress("UNCHECKED_CAST")
        val sinks = compiled.taintFragment["sinks"] as List<Map<String, Any>>
        assertThat(sources).hasSize(2) // srcA appears in both rules, kept once
        assertThat(sinks).hasSize(2)
        assertThat(compiled.taintFragment["callSiteMode"]).isEqualTo(true)
    }

    @Test
    fun `compile rejects empty rule sets`() {
        assertThatThrownBy { TaintRuleCompiler.compile(emptyList()) }
            .hasMessageContaining("No taint rules")
    }

    @Test
    fun `attribution matches rules covering both source and sink`() {
        val compiled = TaintRuleCompiler.compile(
            listOf(
                rule("joint", listOf(srcA), listOf(sinkX), severity = "high"),
                rule("onlySource", listOf(srcA, srcB), listOf(sinkY))
            )
        )
        val joint = compiled.attribute(srcA, sinkX)
        assertThat(joint.crossRule).isFalse()
        assertThat(joint.rules.map { it.name }).containsExactly("joint")
    }

    @Test
    fun `cross-rule flows fall back to contributing rules`() {
        val compiled = TaintRuleCompiler.compile(
            listOf(
                rule("sourceRule", listOf(srcA), listOf(sinkY)),
                rule("sinkRule", listOf(srcB), listOf(sinkX))
            )
        )
        // srcA (sourceRule) -> sinkX (sinkRule): no single rule covers both
        val attribution = compiled.attribute(srcA, sinkX)
        assertThat(attribution.crossRule).isTrue()
        assertThat(attribution.rules.map { it.name }).containsExactlyInAnyOrder("sourceRule", "sinkRule")
    }

    @Test
    fun `attribution of unknown methods is cross-rule with no rules`() {
        val compiled = TaintRuleCompiler.compile(listOf(rule("r", listOf(srcA), listOf(sinkX))))
        val attribution = compiled.attribute("<x.Y: void z()>", "<x.Z: void w()>")
        assertThat(attribution.crossRule).isTrue()
        assertThat(attribution.rules).isEmpty()
    }
}
