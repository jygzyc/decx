package jadx.plugins.decx.api

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * DecxFilter is the shared filtering used by get_classes / search_global_key /
 * search_class_key. The search refactor changed how classes are enumerated, but
 * filter application logic is unchanged — these tests pin that contract.
 */
class DecxFilterTest {

    @Test
    fun `from null yields defaults`() {
        val f = DecxFilter.from(null)
        assertThat(f.limit).isNull()
        assertThat(f.includes).isEmpty()
        assertThat(f.excludes).isEmpty()
        assertThat(f.caseSensitive).isFalse()
        assertThat(f.regex).isTrue()
    }

    @Test
    fun `from map parses all fields`() {
        val f = DecxFilter.from(
            mapOf(
                "limit" to 5,
                "includes" to listOf("a", "b"),
                "excludes" to listOf("c"),
                "caseSensitive" to true,
                "regex" to false
            )
        )
        assertThat(f.limit).isEqualTo(5)
        assertThat(f.includes).containsExactly("a", "b")
        assertThat(f.excludes).containsExactly("c")
        assertThat(f.caseSensitive).isTrue()
        assertThat(f.regex).isFalse()
    }

    @Test
    fun `default compiled filter matches everything`() {
        val c = DecxFilter().compile()!!
        assertThat(c.matches("anything")).isTrue()
        assertThat(c.matches("")).isTrue()
    }

    @Test
    fun `regex includes match and excludes win`() {
        val c = DecxFilter(
            includes = listOf("com\\.example\\..*"),
            excludes = listOf(".*Test")
        ).compile()!!
        assertThat(c.matches("com.example.Foo")).isTrue()
        assertThat(c.matches("org.other.Bar")).isFalse() // not included
        assertThat(c.matches("com.example.UtilTest")).isFalse() // excluded
    }

    @Test
    fun `invalid regex yields null compile`() {
        assertThat(DecxFilter(includes = listOf("[invalid")).compile()).isNull()
        assertThat(DecxFilter(excludes = listOf("(unclosed")).compile()).isNull()
    }

    @Test
    fun `literal mode does substring matching`() {
        val c = DecxFilter(regex = false, includes = listOf("Foo")).compile()!!
        assertThat(c.matches("com.FooBar")).isTrue()
        assertThat(c.matches("com.Bar")).isFalse()
    }

    @Test
    fun `limit takes first n and null returns all`() {
        assertThat(DecxFilter(limit = 2).limit(listOf(1, 2, 3, 4))).containsExactly(1, 2)
        assertThat(DecxFilter(limit = 0).limit(listOf(1, 2, 3))).isEmpty()
        assertThat(DecxFilter().limit(listOf(1, 2, 3))).containsExactly(1, 2, 3)
    }

    @Test
    fun `toQuery emits only set fields`() {
        val q = DecxFilter(limit = 3, includes = listOf("x"), caseSensitive = true).toQuery()
        assertThat(q["limit"]).isEqualTo(3)
        assertThat(q["includes"]).isEqualTo(listOf("x"))
        assertThat(q["caseSensitive"]).isEqualTo(true)
        // empty/default fields are not emitted
        assertThat(q).doesNotContainKey("excludes")
        assertThat(q).doesNotContainKey("regex")
    }
}
