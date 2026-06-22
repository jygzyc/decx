package jadx.plugins.decx.utils

import com.google.gson.Gson
import jadx.plugins.decx.api.DecxError
import kotlin.math.max

object ItemKind {
    const val SYMBOL = "symbol"
    const val CODE = "code"
    const val XREF = "xref"
}

object AnalysisResultUtils {

    private const val MAX_OUTPUT_LENGTH = 65535
    private const val MIN_PAGE_SIZE = 1

    private val gson = Gson()

    fun success(
        kind: String,
        query: Map<String, Any> = emptyMap(),
        items: List<Map<String, Any>>,
        summary: Map<String, Any> = emptyMap()
    ): Map<String, Any> {
        return linkedMapOf(
            "ok" to true,
            "kind" to kind,
            "query" to query,
            "summary" to buildSummary(items.size, items.size, false, summary),
            "items" to items,
            "page" to buildPage(1, items.size, false)
        )
    }

    fun error(
        kind: String,
        query: Map<String, Any> = emptyMap(),
        code: String,
        message: String
    ): Map<String, Any> {
        return linkedMapOf(
            "ok" to false,
            "kind" to kind,
            "query" to query,
            "error" to linkedMapOf(
                "code" to code,
                "message" to message
            )
        )
    }

    fun error(
        kind: String,
        query: Map<String, Any> = emptyMap(),
        error: DecxError,
        vararg args: Any
    ): Map<String, Any> {
        return error(kind, query, error.code, error.format(*args))
    }

    fun item(
        id: String,
        kind: String,
        title: String = "",
        content: String = "",
        meta: Map<String, Any> = emptyMap()
    ): Map<String, Any> {
        return linkedMapOf(
            "id" to id,
            "kind" to kind,
            "title" to title,
            "content" to content,
            "meta" to meta
        )
    }

    fun paginate(response: Map<String, Any>, page: Int): Map<String, Any> {
        val ok = response["ok"] as? Boolean ?: false
        if (!ok) {
            return response
        }

        @Suppress("UNCHECKED_CAST")
        val items = response["items"] as? List<Map<String, Any>> ?: emptyList()
        val pageIndex = max(page, 1)
        if (pageIndex == 1 && gson.toJson(response).length <= MAX_OUTPUT_LENGTH) {
            return response
        }

        return if (isSingleCodeItem(items)) {
            paginateCodeResponse(response, items.first(), pageIndex)
        } else {
            paginateListResponse(response, items, pageIndex)
        }
    }

    private fun paginateListResponse(
        response: Map<String, Any>,
        items: List<Map<String, Any>>,
        pageIndex: Int
    ): Map<String, Any> {
        val pageSize = findOptimalListPageSize(response, items)
        val start = (pageIndex - 1) * pageSize
        val end = (start + pageSize).coerceAtMost(items.size)
        val pageItems = if (start >= items.size) emptyList() else items.subList(start, end)
        val hasNext = end < items.size

        return response.toMutableMap().apply {
            put("items", pageItems)
            put("summary", updateSummary(response, items.size, pageItems.size, hasNext))
            put("page", buildPage(pageIndex, pageSize, hasNext))
        }
    }

    private fun paginateCodeResponse(
        response: Map<String, Any>,
        item: Map<String, Any>,
        pageIndex: Int
    ): Map<String, Any> {
        val text = item["content"]?.toString() ?: ""
        val lines = text.split('\n')
        val pageSize = findOptimalCodePageSize(response, item, lines)
        val start = (pageIndex - 1) * pageSize
        val end = (start + pageSize).coerceAtMost(lines.size)
        val pageText = if (start >= lines.size) "" else lines.subList(start, end).joinToString("\n")
        val hasNext = end < lines.size
        val returned = if (start >= lines.size) 0 else 1

        @Suppress("UNCHECKED_CAST")
        val originalMeta = item["meta"] as? Map<String, Any> ?: emptyMap()
        val pagedItem = item.toMutableMap().apply {
            put("content", pageText)
            put("meta", originalMeta.toMutableMap().apply {
                put("line_start", if (lines.isEmpty() || start >= lines.size) 0 else start + 1)
                put("line_end", if (lines.isEmpty() || start >= lines.size) 0 else end)
                put("total_lines", lines.size)
            })
        }

        return response.toMutableMap().apply {
            put("items", listOf(pagedItem))
            put("summary", updateSummary(response, 1, returned, hasNext, extra = linkedMapOf("total_lines" to lines.size)))
            put("page", buildPage(pageIndex, pageSize, hasNext))
        }
    }

    private fun isSingleCodeItem(items: List<Map<String, Any>>): Boolean {
        if (items.size != 1) return false
        return items.first()["kind"] == ItemKind.CODE
    }

    private fun findOptimalListPageSize(response: Map<String, Any>, items: List<Map<String, Any>>): Int {
        var low = MIN_PAGE_SIZE
        var high = max(MIN_PAGE_SIZE, items.size.takeIf { it > 0 } ?: 1)
        var best = MIN_PAGE_SIZE

        while (low <= high) {
            val mid = (low + high) / 2
            val testItems = items.take(mid)
            val testResponse = response.toMutableMap().apply {
                put("items", testItems)
                put("summary", updateSummary(response, items.size, testItems.size, items.size > mid))
                put("page", linkedMapOf<String, Any>("index" to 1, "size" to mid, "has_next" to (items.size > mid)))
            }
            if (gson.toJson(testResponse).length <= MAX_OUTPUT_LENGTH) {
                best = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }

        return best
    }

    private fun findOptimalCodePageSize(
        response: Map<String, Any>,
        item: Map<String, Any>,
        lines: List<String>
    ): Int {
        var low = MIN_PAGE_SIZE
        var high = max(MIN_PAGE_SIZE, lines.size.takeIf { it > 0 } ?: 1)
        var best = MIN_PAGE_SIZE

        while (low <= high) {
            val mid = (low + high) / 2
            val preview = lines.take(mid).joinToString("\n")

            @Suppress("UNCHECKED_CAST")
            val meta = (item["meta"] as? Map<String, Any>).orEmpty().toMutableMap().apply {
                put("line_start", 1)
                put("line_end", minOf(mid, lines.size))
                put("total_lines", lines.size)
            }

            val testItem = item.toMutableMap().apply {
                put("content", preview)
                put("meta", meta)
            }

            val testResponse = response.toMutableMap().apply {
                put("items", listOf(testItem))
                put("summary", updateSummary(response, 1, 1, lines.size > mid, extra = linkedMapOf("total_lines" to lines.size)))
                put("page", linkedMapOf<String, Any>("index" to 1, "size" to mid, "has_next" to (lines.size > mid)))
            }

            if (gson.toJson(testResponse).length <= MAX_OUTPUT_LENGTH) {
                best = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }

        return best
    }

    private fun buildSummary(
        total: Int,
        returned: Int,
        truncated: Boolean,
        extra: Map<String, Any> = emptyMap()
    ): Map<String, Any> {
        return linkedMapOf<String, Any>(
            "total" to total,
            "returned" to returned,
            "truncated" to truncated
        ).apply {
            putAll(extra)
        }
    }

    private fun updateSummary(
        response: Map<String, Any>,
        total: Int,
        returned: Int,
        truncated: Boolean,
        extra: Map<String, Any> = emptyMap()
    ): Map<String, Any> {
        @Suppress("UNCHECKED_CAST")
        val summary = response["summary"] as? Map<String, Any> ?: emptyMap()
        return buildSummary(total, returned, truncated, summary + extra - "total" - "returned" - "truncated")
    }

    private fun buildPage(index: Int, size: Int, hasNext: Boolean): Map<String, Any> {
        return linkedMapOf(
            "index" to index,
            "size" to size,
            "has_next" to hasNext
        )
    }
}
