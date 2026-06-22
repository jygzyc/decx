package jadx.plugins.decx.api

import jadx.plugins.decx.utils.AnalysisResultUtils

/**
 * Unified result envelope for every DECX API/service call.
 *
 * `success` is the transport-neutral success flag used by HTTP/MCP adapters.
 * `data` is the response body returned to clients. Service implementations must
 * build it with AnalysisResultUtils so every response has the same top-level
 * shape:
 *
 * Success:
 *   ok, kind, query, summary, items, page
 *
 * Failure:
 *   ok, kind, query, error
 */
data class DecxApiResult(
    val success: Boolean,
    val data: Map<String, Any>
) {
    companion object {
        fun ok(data: Map<String, Any>) = DecxApiResult(true, data)
        fun fail(data: Map<String, Any>) = DecxApiResult(false, data)

        fun success(
            kind: String,
            query: Map<String, Any> = emptyMap(),
            items: List<Map<String, Any>>,
            summary: Map<String, Any> = emptyMap()
        ) = ok(AnalysisResultUtils.success(kind, query, items, summary))

        fun error(
            kind: String,
            query: Map<String, Any> = emptyMap(),
            code: String,
            message: String
        ) = fail(AnalysisResultUtils.error(kind, query, code, message))

        fun error(
            kind: String,
            query: Map<String, Any> = emptyMap(),
            error: DecxError,
            vararg args: Any
        ) = fail(AnalysisResultUtils.error(kind, query, error, *args))
    }
}
