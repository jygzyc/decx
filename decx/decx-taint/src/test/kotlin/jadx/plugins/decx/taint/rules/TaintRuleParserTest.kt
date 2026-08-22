package jadx.plugins.decx.taint.rules

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class TaintRuleParserTest {

    @TempDir
    lateinit var tempDir: File

    private val validDoc = """
        {
          "leak": {
            "description": "desc",
            "category": "Cat",
            "severity": "high",
            "sources": [{ "method": "<a.b.C: java.lang.String src()>", "index": "result" }],
            "sinks": [{ "method": "<a.b.D: void sink(java.lang.String)>", "index": 0 }],
            "transfers": [{ "method": "<java.lang.StringBuilder: java.lang.StringBuilder append(java.lang.String)>", "from": "0", "to": "result" }],
            "sanitizers": []
          }
        }
    """.trimIndent()

    @Test
    fun `parses a valid document with numeric index coercion`() {
        val rules = TaintRuleParser.parseDocument(validDoc)
        assertThat(rules).hasSize(1)
        val rule = rules[0]
        assertThat(rule.name).isEqualTo("leak")
        assertThat(rule.severity).isEqualTo("high")
        assertThat(rule.sources[0].index).isEqualTo("result")
        assertThat(rule.sinks[0].index).isEqualTo("0") // JSON 0 -> "0", never "0.0"
        assertThat(rule.transfers[0].from).isEqualTo("0")
    }

    @Test
    fun `rejects invalid json`() {
        assertThatThrownBy { TaintRuleParser.parseDocument("{ nope") }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `rejects empty document`() {
        assertThatThrownBy { TaintRuleParser.parseDocument("{}") }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("no rules")
    }

    @Test
    fun `rejects malformed method signature`() {
        val doc = """
            { "r": {
                "sources": [{ "method": "android.util.Log.i", "index": "result" }],
                "sinks": [{ "method": "<a.b.D: void sink(java.lang.String)>", "index": 0 }]
            } }
        """.trimIndent()
        assertThatThrownBy { TaintRuleParser.parseDocument(doc) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("signature")
    }

    @Test
    fun `rejects bad position values`() {
        val doc = """
            { "r": {
                "sources": [{ "method": "<a.b.C: java.lang.String src()>", "index": "everywhere" }],
                "sinks": [{ "method": "<a.b.D: void sink(java.lang.String)>", "index": 0 }]
            } }
        """.trimIndent()
        assertThatThrownBy { TaintRuleParser.parseDocument(doc) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("index")
    }

    @Test
    fun `rejects unknown severity`() {
        val doc = """
            { "r": {
                "severity": "extreme",
                "sources": [{ "method": "<a.b.C: java.lang.String src()>", "index": "result" }],
                "sinks": [{ "method": "<a.b.D: void sink(java.lang.String)>", "index": 0 }]
            } }
        """.trimIndent()
        assertThatThrownBy { TaintRuleParser.parseDocument(doc) }
            .hasMessageContaining("severity")
    }

    @Test
    fun `rejects missing sources or sinks`() {
        val noSinks = """{ "r": { "sources": [{ "method": "<a.b.C: java.lang.String src()>", "index": "result" }] } }"""
        assertThatThrownBy { TaintRuleParser.parseDocument(noSinks) }
            .hasMessageContaining("sinks")
        val noSources = """{ "r": { "sinks": [{ "method": "<a.b.D: void sink(java.lang.String)>", "index": 0 }] } }"""
        assertThatThrownBy { TaintRuleParser.parseDocument(noSources) }
            .hasMessageContaining("sources")
    }

    @Test
    fun `loads rules from a directory`() {
        File(tempDir, "a.json").writeText(validDoc)
        File(tempDir, "b.json").writeText("""{ "other": {
            "sources": [{ "method": "<a.b.C: java.lang.String src2()>", "index": "result" }],
            "sinks": [{ "method": "<a.b.D: void sink(java.lang.String)>", "index": 0 }]
        } }""")
        val rules = TaintRuleParser.loadDir(tempDir)
        assertThat(rules.map { it.name }).containsExactlyInAnyOrder("leak", "other")
        assertThat(rules[0].origin).contains("a.json")
    }

    @Test
    fun `loadDir rejects missing or empty directories`() {
        assertThatThrownBy { TaintRuleParser.loadDir(File(tempDir, "nope")) }
            .hasMessageContaining("not a directory")
        val empty = File(tempDir, "empty").apply { mkdirs() }
        assertThatThrownBy { TaintRuleParser.loadDir(empty) }
            .hasMessageContaining("no rule files")
    }

    @Test
    fun `select filters by name and rejects unknown names`() {
        val rules = TaintRuleParser.parseDocument(validDoc)
        assertThat(TaintRuleParser.select(rules, listOf("leak"))).hasSize(1)
        assertThat(TaintRuleParser.select(rules, emptyList())).hasSize(1)
        assertThatThrownBy { TaintRuleParser.select(rules, listOf("ghost")) }
            .hasMessageContaining("ghost")
    }

    @Test
    fun `built-in privacy-leak rules load from the classpath`() {
        val rules = TaintRuleParser.loadBuiltin()
        assertThat(rules.map { it.name }).contains("deviceIdLeak", "locationLeak", "userInputLeak")
        assertThat(rules.all { it.origin == TaintRule.ORIGIN_BUILTIN }).isTrue()
        assertThat(rules.flatMap { it.sources }).isNotEmpty()
        assertThat(rules.flatMap { it.sinks }).isNotEmpty()
    }
}
