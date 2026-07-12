package jadx.plugins.decx.server.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class RuleLoaderTest {

    @TempDir
    lateinit var tempDir: Path

    @Test
    fun `loads single rule from YAML`() {
        val ruleFile = tempDir.resolve("test-rule.yml").toFile()
        ruleFile.writeText("""
            id: test_rule
            description: "A test investigation rule"
            category: test_category
            target_sdk: "26:34"
            targets:
              - kind: method
                signature: "<com.example.Foo: void bar()>"
            collect:
              - kind: callers
                include_callees: true
              - kind: variable_flow
                variable: return
                depth: 10
            context:
              - kind: dynamic_receivers
        """.trimIndent())

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(1)
        val rule = rules[0]
        assertThat(rule.id).isEqualTo("test_rule")
        assertThat(rule.description).isEqualTo("A test investigation rule")
        assertThat(rule.category).isEqualTo("test_category")
        assertThat(rule.targetSdk).isEqualTo("26:34")
        assertThat(rule.targets).hasSize(1)
        assertThat(rule.targets!![0].kind).isEqualTo("method")
        assertThat(rule.targets!![0].signature).isEqualTo("<com.example.Foo: void bar()>")
        assertThat(rule.collect).hasSize(2)
        assertThat(rule.collect!![0].kind).isEqualTo("callers")
        assertThat(rule.collect!![0].includeCallees).isTrue()
        assertThat(rule.collect!![1].kind).isEqualTo("variable_flow")
        assertThat(rule.collect!![1].variable).isEqualTo("return")
        assertThat(rule.collect!![1].depth).isEqualTo(10)
        assertThat(rule.context).hasSize(1)
        assertThat(rule.context!![0].kind).isEqualTo("dynamic_receivers")
    }

    @Test
    fun `loads multiple rules from separate files`() {
        tempDir.resolve("rule1.yml").toFile().writeText("""
            id: rule_one
            description: "First rule"
            targets:
              - kind: method
                signature: "<A: void a()>"
            collect:
              - kind: callers
        """.trimIndent())
        tempDir.resolve("rule2.yml").toFile().writeText("""
            id: rule_two
            description: "Second rule"
            targets:
              - kind: method
                signature: "<B: void b()>"
            collect:
              - kind: callees
        """.trimIndent())

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(2)
        assertThat(rules.map { it.id }).containsExactly("rule_one", "rule_two")
    }

    @Test
    fun `returns empty list for nonexistent directory`() {
        val rules = RuleLoader.load(File("/nonexistent/path"))
        assertThat(rules).isEmpty()
    }

    @Test
    fun `handles missing optional fields`() {
        tempDir.resolve("minimal.yml").toFile().writeText("""
            id: minimal_rule
            description: "Minimal rule with no targets or collect"
        """.trimIndent())

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(1)
        val rule = rules[0]
        assertThat(rule.id).isEqualTo("minimal_rule")
        assertThat(rule.targets.orEmpty()).isEmpty()
        assertThat(rule.collect.orEmpty()).isEmpty()
        assertThat(rule.context).isNull()
        assertThat(rule.targetSdk).isNull()
        assertThat(rule.category ?: "general").isEqualTo("general")
    }

    @Test
    fun `skips malformed YAML files gracefully`() {
        tempDir.resolve("good.yml").toFile().writeText("""
            id: good_rule
            description: "Valid rule"
            targets: []
            collect: []
        """.trimIndent())
        tempDir.resolve("bad.yml").toFile().writeText("this: is: not: valid: yaml: [")

        val rules = RuleLoader.load(tempDir.toFile())
        assertThat(rules).hasSize(1)
        assertThat(rules[0].id).isEqualTo("good_rule")
    }
}
