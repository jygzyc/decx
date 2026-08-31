package jadx.plugins.decx.utils

import jadx.api.ICodeInfo
import jadx.api.impl.SimpleCodeInfo
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class BoundedCodeCacheTest {

    private fun code(text: String): ICodeInfo = SimpleCodeInfo(text)

    private fun sizeOf(text: String): Long = text.length.toLong() * 2 + 1024

    @Test
    fun addAndGetRoundTrips() {
        val cache = BoundedCodeCache(maxBytes = 1_000_000)
        cache.add("a", code("hello"))
        assertThat(cache.get("a").codeStr).isEqualTo("hello")
        assertThat(cache.getCode("a")).isEqualTo("hello")
        assertThat(cache.contains("a")).isTrue()
        assertThat(cache.get("missing")).isSameAs(ICodeInfo.EMPTY)
    }

    @Test
    fun evictsLruEntriesBeyondByteBudget() {
        val evicted = mutableListOf<String>()
        // Budget fits exactly two entries of ~"AAAA"(2040+1024 ≈ 3064 bytes each);
        // make the cap hold two entries but not three.
        val cache = BoundedCodeCache(maxBytes = sizeOf("AAAA") * 2) { evicted.add(it) }

        cache.add("a", code("AAAA"))
        cache.add("b", code("BBBB"))
        assertThat(cache.contains("a")).isTrue()
        assertThat(cache.contains("b")).isTrue()

        cache.add("c", code("CCCC")) // evicts "a" (LRU)
        assertThat(cache.contains("a")).isFalse()
        assertThat(cache.contains("b")).isTrue()
        assertThat(cache.contains("c")).isTrue()
        assertThat(evicted).containsExactly("a")
    }

    @Test
    fun getRefreshesRecency() {
        val evicted = mutableListOf<String>()
        val cache = BoundedCodeCache(maxBytes = sizeOf("AAAA") * 2) { evicted.add(it) }

        cache.add("a", code("AAAA"))
        cache.add("b", code("BBBB"))
        cache.get("a") // touch: "b" is now LRU
        cache.add("c", code("CCCC"))

        assertThat(cache.contains("a")).isTrue()
        assertThat(cache.contains("b")).isFalse()
        assertThat(evicted).containsExactly("b")
    }

    @Test
    fun reAddReplacesAndReaccountsBytes() {
        val cache = BoundedCodeCache(maxBytes = 1_000_000)
        cache.add("a", code("AAAA"))
        cache.add("a", code("AAAAAA"))
        assertThat(cache.stats()["bytes"]).isEqualTo(sizeOf("AAAAAA"))
        assertThat(cache.get("a").codeStr).isEqualTo("AAAAAA")
    }

    @Test
    fun removeAndCloseDropEntries() {
        val cache = BoundedCodeCache(maxBytes = 1_000_000)
        cache.add("a", code("AAAA"))
        cache.add("b", code("BBBB"))
        cache.remove("a")
        assertThat(cache.contains("a")).isFalse()
        assertThat(cache.contains("b")).isTrue()

        cache.close()
        assertThat(cache.contains("b")).isFalse()
        assertThat(cache.stats()["entries"]).isEqualTo(0)
        assertThat(cache.stats()["bytes"]).isEqualTo(0L)
    }

    @Test
    fun clearKeepsCacheUsable() {
        val cache = BoundedCodeCache(maxBytes = 1_000_000)
        cache.add("a", code("AAAA"))
        cache.clear()
        assertThat(cache.contains("a")).isFalse()
        assertThat(cache.stats()["entries"]).isEqualTo(0)
        // still usable after clear
        cache.add("b", code("BBBB"))
        assertThat(cache.get("b").codeStr).isEqualTo("BBBB")
    }

    @Test
    fun emptyCodeInfoIsNeverStored() {
        val cache = BoundedCodeCache(maxBytes = 1_000_000)
        cache.add("a", ICodeInfo.EMPTY)
        assertThat(cache.contains("a")).isFalse()
    }
}
