package jadx.plugins.decx.taint.config

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class TaintConfigParserTest {

    // ------------------------------------------------------------------
    // Preset resolution
    // ------------------------------------------------------------------

    @Test
    fun `preset fills analysis limits and taint defaults`() {
        val cfg = TaintConfigParser.resolve(
            """
            preset: privacy-leak
            target: { session: sieve }
            """.trimIndent()
        )
        assertThat(cfg.engine).isEqualTo("taie")
        assertThat(cfg.target.session).isEqualTo("sieve")
        assertThat(cfg.analysis.algorithm).isEqualTo("pta")
        assertThat(cfg.analysis.contextSensitivity).isEqualTo("ci")
        assertThat(cfg.limits.timeoutSec).isEqualTo(600)
        assertThat(cfg.taint.sources).isNotEmpty()
        assertThat(cfg.taint.sinks).isNotEmpty()
        assertThat(cfg.taint.sources.first()["method"].toString()).contains("getImei")
    }

    @Test
    fun `unknown preset fails fast`() {
        assertThatThrownBy {
            TaintConfigParser.resolve(
                """
                preset: no-such-preset
                target: { session: sieve }
                """.trimIndent()
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("Unknown taint preset")
    }

    // ------------------------------------------------------------------
    // Override semantics
    // ------------------------------------------------------------------

    @Test
    fun `user fields override preset fields at field level`() {
        val cfg = TaintConfigParser.resolve(
            """
            preset: privacy-leak
            target: { session: sieve }
            analysis:
              contextSensitivity: 2obj
            limits:
              timeoutSec: 1200
            """.trimIndent()
        )
        assertThat(cfg.analysis.algorithm).isEqualTo("pta")   // untouched
        assertThat(cfg.analysis.contextSensitivity).isEqualTo("2obj")  // overridden
        assertThat(cfg.limits.timeoutSec).isEqualTo(1200)      // overridden
        assertThat(cfg.taint.sinks).isNotEmpty()               // inherited from preset
    }

    @Test
    fun `user taint rules replace preset taint rules`() {
        val cfg = TaintConfigParser.resolve(
            """
            preset: privacy-leak
            target: { session: sieve }
            taint:
              sources:
                - { kind: call, method: "<A: java.lang.String a()>", index: result }
              sinks:
                - { method: "<B: void b(java.lang.String)>", index: 0 }
            """.trimIndent()
        )
        assertThat(cfg.taint.sources).hasSize(1)
        assertThat(cfg.taint.sources.first()["method"]).isEqualTo("<A: java.lang.String a()>")
        assertThat(cfg.taint.sinks).hasSize(1)
        // preset sinks were replaced entirely
        assertThat(cfg.taint.sinks.none { (it["method"] as String).contains("Log") }).isTrue()
    }

    // ------------------------------------------------------------------
    // Fully custom config (no preset)
    // ------------------------------------------------------------------

    @Test
    fun `fully custom config without preset works`() {
        val cfg = TaintConfigParser.resolve(
            """
            target: { apk: /tmp/x.apk }
            analysis: { algorithm: pta, contextSensitivity: 2obj, scope: REACHABLE }
            limits: { timeoutSec: 300 }
            taint:
              sources:
                - { kind: call, method: "<S: java.lang.String s()>", index: result }
              sinks:
                - { method: "<K: void k(java.lang.String)>", index: 0 }
            """.trimIndent()
        )
        assertThat(cfg.target.apk).isEqualTo("/tmp/x.apk")
        assertThat(cfg.analysis.scope).isEqualTo("REACHABLE")
        assertThat(cfg.limits.timeoutSec).isEqualTo(300)
        assertThat(cfg.taint.sources).hasSize(1)
    }

    // ------------------------------------------------------------------
    // Raw escape hatch
    // ------------------------------------------------------------------

    @Test
    fun `raw options pass through verbatim`() {
        val cfg = TaintConfigParser.resolve(
            """
            preset: privacy-leak
            target: { session: sieve }
            raw:
              cs: 2obj+H
              "distinguish-all-strings": true
            """.trimIndent()
        )
        assertThat(cfg.raw).isNotNull()
        assertThat(cfg.raw!!["cs"]).isEqualTo("2obj+H")
        assertThat(cfg.raw!!["distinguish-all-strings"]).isEqualTo(true)
    }

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------

    @Test
    fun `missing target is rejected`() {
        assertThatThrownBy {
            TaintConfigParser.resolve("preset: privacy-leak")
        }.isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("target")
    }

    @Test
    fun `both session and apk is rejected`() {
        assertThatThrownBy {
            TaintConfigParser.resolve(
                """
                target: { session: s, apk: /tmp/x.apk }
                taint:
                  sources: [{ kind: call, method: "<S: java.lang.String s()>", index: result }]
                  sinks: [{ method: "<K: void k(java.lang.String)>", index: 0 }]
                """.trimIndent()
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("either session or apk")
    }

    @Test
    fun `empty taint rules are rejected`() {
        assertThatThrownBy {
            TaintConfigParser.resolve(
                """
                target: { apk: /tmp/x.apk }
                taint: { callSiteMode: true }
                """.trimIndent()
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("no sources/sinks")
    }

    @Test
    fun `invalid algorithm is rejected`() {
        assertThatThrownBy {
            TaintConfigParser.resolve(
                """
                target: { apk: /tmp/x.apk }
                analysis: { algorithm: bogus }
                taint:
                  sources: [{ kind: call, method: "<S: java.lang.String s()>", index: result }]
                  sinks: [{ method: "<K: void k(java.lang.String)>", index: 0 }]
                """.trimIndent()
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("algorithm")
    }

    @Test
    fun `invalid yaml is rejected`() {
        assertThatThrownBy {
            TaintConfigParser.resolve("target: [unclosed")
        }.isInstanceOf(IllegalArgumentException::class.java)
    }

    // ------------------------------------------------------------------
    // Preset listing
    // ------------------------------------------------------------------

    @Test
    fun `built-in presets are listable`() {
        val presets = TaintConfigParser.listPresets()
        val names = presets.map { it["name"] }
        assertThat(names).contains("privacy-leak", "quick-scan")
    }
}
