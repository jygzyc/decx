package jadx.plugins.decx.utils

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Validates the new compressed-source cache layer of [DecompileGuard].
 *
 * Note: full [DecompileGuard.source] behaviour cannot be unit-tested here because
 * `jadx.api.JavaClass` / `JadxDecompiler` are final with package-private constructors
 * (no fake possible without a real APK). The compression round-trip and the
 * stats/clear surface are pure and exercised below.
 */
class DecompileGuardCacheTest {

    @BeforeEach
    fun isolate() {
        DecompileGuard.clearCache()
    }

    @Test
    fun `compress then decompress round-trips ascii and actually shrinks`() {
        val src = "public class Foo { void bar() {} }\n".repeat(80)
        val compressed = DecompileGuard.compress(src.toByteArray(Charsets.UTF_8))
        assertThat(compressed).isNotNull
        assertThat(DecompileGuard.decompress(compressed!!)).isEqualTo(src)
        assertThat(compressed.size).isLessThan(src.length)
    }

    @Test
    fun `compress then decompress round-trips edge cases`() {
        val cases = listOf("", "a", "中文 / ñ / ünicödé", "line1\nline2\ttab")
        for (src in cases) {
            val compressed = DecompileGuard.compress(src.toByteArray(Charsets.UTF_8))
            assertThat(compressed).isNotNull
            assertThat(DecompileGuard.decompress(compressed!!)).isEqualTo(src)
        }
    }

    @Test
    fun `stats reports empty state after clear`() {
        val s = DecompileGuard.stats()
        assertThat(s["kind"]).isEqualTo("decompile_source")
        assertThat(s["entries"]).isEqualTo(0)
        assertThat(s["hits"]).isEqualTo(0L)
        assertThat(s["misses"]).isEqualTo(0L)
        assertThat(s["hit_rate"]).isEqualTo("N/A")
    }

    @Test
    fun `clearCache is idempotent`() {
        // clearing an already-empty cache must not throw
        DecompileGuard.clearCache()
        DecompileGuard.clearCache()
        assertThat(DecompileGuard.stats()["entries"]).isEqualTo(0)
    }
}
