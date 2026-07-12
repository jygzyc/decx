package decx.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class RuleLoaderTest {

    @TempDir
    lateinit var tempDir: Path

    @Test
    fun `loads AppShark-style source sink rule from YAML`() {
        val ruleFile = tempDir.resolve("intent-redir.yml").toFile()
        ruleFile.writeText("""
            id: intent_redirection
            name: "Intent Redirection"
            description: "Parcelable extra to startActivity"
            severity: high
            category: intent_redirection
            trace_depth: 10
            source:
              - kind: return
                method: "<android.os.BaseBundle: android.os.Parcelable getParcelable(java.lang.String)>"
            sink:
              - method: "<android.app.Activity: void startActivity(android.content.Intent)>"
                taint_check: ["p0"]
                param_type: ["android.content.Intent"]
            sanitizer:
              - name: null_check
                method: "<java.lang.Object: boolean equals(java.lang.Object)>"
                taint_check: ["p0"]
        """.trimIndent())

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(1)
        val rule = rules[0]
        assertThat(rule.id).isEqualTo("intent_redirection")
        assertThat(rule.name).isEqualTo("Intent Redirection")
        assertThat(rule.severity).isEqualTo("high")
        assertThat(rule.traceDepth).isEqualTo(10)

        assertThat(rule.source).hasSize(1)
        assertThat(rule.source!![0].kind).isEqualTo("return")
        assertThat(rule.source!![0].method).contains("getParcelable")

        assertThat(rule.sink).hasSize(1)
        assertThat(rule.sink!![0].method).contains("startActivity")
        assertThat(rule.sink!![0].taintCheck).containsExactly("p0")
        assertThat(rule.sink!![0].paramType).containsExactly("android.content.Intent")

        assertThat(rule.sanitizer).hasSize(1)
        assertThat(rule.sanitizer!![0].name).isEqualTo("null_check")
    }

    @Test
    fun `loads multiple rules from separate files`() {
        tempDir.resolve("a.yml").toFile().writeText("""
            id: rule_a
            name: "Rule A"
            description: "First"
            source:
              - kind: return
                method: "<A: void a()>"
            sink:
              - method: "<B: void b()>"
                taint_check: ["p0"]
        """.trimIndent())
        tempDir.resolve("b.yml").toFile().writeText("""
            id: rule_b
            name: "Rule B"
            description: "Second"
            source:
              - kind: param
                method: "<C: void c()>"
                position: "p0"
            sink:
              - method: "<D: void d()>"
                taint_check: ["p*"]
        """.trimIndent())

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(2)
        assertThat(rules.map { it.id }).containsExactly("rule_a", "rule_b")
    }

    @Test
    fun `returns empty for nonexistent directory`() {
        assertThat(RuleLoader.load(File("/nonexistent"))).isEmpty()
    }

    @Test
    fun `handles minimal rule with no optional fields`() {
        tempDir.resolve("minimal.yml").toFile().writeText("""
            id: minimal
            name: "Minimal"
            description: "No source or sink"
        """.trimIndent())

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(1)
        assertThat(rules[0].source).isNull()
        assertThat(rules[0].sink).isNull()
        assertThat(rules[0].sanitizer).isNull()
    }

    @Test
    fun `parseYaml handles inline custom rule`() {
        val yaml = """
            id: custom_test
            name: "Custom"
            description: "AI-generated rule"
            source:
              - kind: return
                method: "<com.example.Foo: java.lang.String getSecret()>"
            sink:
              - method: "<android.util.Log: int d(java.lang.String,java.lang.String)>"
                taint_check: ["p1"]
        """.trimIndent()

        val rule = RuleLoader.parseYaml(yaml)
        assertThat(rule).isNotNull
        assertThat(rule!!.id).isEqualTo("custom_test")
        assertThat(rule.source!![0].method).contains("getSecret")
        assertThat(rule.sink!![0].taintCheck).containsExactly("p1")
    }

    @Test
    fun `skips malformed YAML gracefully`() {
        tempDir.resolve("good.yml").toFile().writeText("""
            id: good
            name: "Good"
            description: "Valid"
            source: []
            sink: []
        """.trimIndent())
        tempDir.resolve("bad.yml").toFile().writeText("invalid: : : yaml: [")

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(1)
        assertThat(rules[0].id).isEqualTo("good")
    }

    @Test
    fun `resolves param template placeholders`() {
        val yaml = """
            id: trace_flow
            name: "Trace Flow"
            description: "Parameterized"
            source:
              - kind: return
                method: "{{source_method}}"
            sink:
              - method: "{{sink_method}}"
                taint_check: ["{{sink_position}}"]
        """.trimIndent()

        val rule = RuleLoader.parseYaml(yaml)!!
        val resolved = rule.resolveParams(mapOf(
            "source_method" to "<com.example.A: java.lang.String getData()>",
            "sink_method" to "<com.example.B: void useData(java.lang.String)>",
            "sink_position" to "p0"
        ))

        assertThat(resolved.source!![0].method).isEqualTo("<com.example.A: java.lang.String getData()>")
        assertThat(resolved.sink!![0].method).isEqualTo("<com.example.B: void useData(java.lang.String)>")
        assertThat(resolved.sink!![0].taintCheck).containsExactly("p0")
    }

    @Test
    fun `loads parameterized rule with parameters field`() {
        val yaml = """
            id: trace_data_flow
            name: "Trace Data Flow"
            description: "Generic"
            parameters:
              - name: source_method
                type: method_signature
                description: "Source method"
                required: true
              - name: sink_position
                type: taint_position
                description: "Sink arg position"
                required: false
                default_value: "p*"
            source:
              - kind: return
                method: "{{source_method}}"
            sink:
              - method: "<Sink: void go()>"
                taint_check: ["{{sink_position}}"]
        """.trimIndent()

        val rule = RuleLoader.parseYaml(yaml)!!
        assertThat(rule.parameters).hasSize(2)
        assertThat(rule.parameters!![0].name).isEqualTo("source_method")
        assertThat(rule.parameters!![0].required).isTrue()
        assertThat(rule.parameters!![1].defaultValue).isEqualTo("p*")
        assertThat(rule.parameters!![1].required).isFalse()
    }
}
