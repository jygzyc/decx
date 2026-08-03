package jadx.plugins.decx.utils

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Pins the response-envelope shape produced by services and consumed by
 * RouteHandler / HTTP / MCP adapters. Removing the response cache (CacheUtils)
 * must not change this contract.
 */
class AnalysisResultUtilsTest {

    @Test
    fun successEnvelopeShape() {
        val items = listOf(AnalysisResultUtils.item("a", ItemKind.SYMBOL, "A", "aa"))
        val r = AnalysisResultUtils.success("classes", mapOf("k" to "v"), items, mapOf("extra" to 1))

        assertThat(r["ok"]).isEqualTo(true)
        assertThat(r["kind"]).isEqualTo("classes")
        assertThat(r["query"]).isEqualTo(mapOf("k" to "v"))
        assertThat(r["items"]).isEqualTo(items)
        val summary = r["summary"] as Map<*, *>
        assertThat(summary["total"]).isEqualTo(1)
        assertThat(summary["returned"]).isEqualTo(1)
        assertThat(summary["truncated"]).isEqualTo(false)
        assertThat(summary["extra"]).isEqualTo(1)
        val page = r["page"] as Map<*, *>
        assertThat(page["index"]).isEqualTo(1)
    }

    @Test
    fun errorEnvelopeShape() {
        val r = AnalysisResultUtils.error("classes", mapOf("k" to "v"), "BAD_CODE", "nope")
        assertThat(r["ok"]).isEqualTo(false)
        assertThat(r["kind"]).isEqualTo("classes")
        assertThat(r["query"]).isEqualTo(mapOf("k" to "v"))
        val err = r["error"] as Map<*, *>
        assertThat(err["code"]).isEqualTo("BAD_CODE")
        assertThat(err["message"]).isEqualTo("nope")
        assertThat(r).doesNotContainKey("items")
    }

    @Test
    fun itemCarriesIdKindTitleContentMeta() {
        val it = AnalysisResultUtils.item("id1", ItemKind.CODE, "Title", "body", mapOf("language" to "java"))
        assertThat(it["id"]).isEqualTo("id1")
        assertThat(it["kind"]).isEqualTo(ItemKind.CODE)
        assertThat(it["title"]).isEqualTo("Title")
        assertThat(it["content"]).isEqualTo("body")
        assertThat((it["meta"] as Map<*, *>)["language"]).isEqualTo("java")
    }

    @Test
    fun paginatePassesSmallPage1ResponsesThrough() {
        val items = listOf(AnalysisResultUtils.item("a", ItemKind.SYMBOL, "A", "aa"))
        val r = AnalysisResultUtils.success("classes", emptyMap(), items)
        val paged = AnalysisResultUtils.paginate(r, 1)
        assertThat(paged["items"]).isEqualTo(items)
    }

    @Test
    fun paginateLeavesErrorResponsesUntouched() {
        val err = AnalysisResultUtils.error("classes", emptyMap(), "BAD", "x")
        assertThat(AnalysisResultUtils.paginate(err, 1)).isSameAs(err)
    }
}
