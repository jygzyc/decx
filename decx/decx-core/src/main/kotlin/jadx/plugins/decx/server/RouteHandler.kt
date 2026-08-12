package jadx.plugins.decx.server

import jadx.plugins.decx.api.DecxApi
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxRequestParams
import jadx.plugins.decx.api.DecxRoutes
import jadx.plugins.decx.extension.DecxExtensions
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.LogUtils

class RouteHandler(private val api: DecxApi) {

    fun handle(path: String, payload: Map<String, Any>, page: Int): Map<String, Any> {
        LogUtils.info("[API] $path: $payload")
        val result = dispatch(path, payload)
        return if (result.success) {
            AnalysisResultUtils.paginate(result.data, page)
        } else {
            result.data
        }
    }

    private fun dispatch(path: String, payload: Map<String, Any>): DecxApiResult {
        val route = DecxRoutes.routeOf(path)
            ?: DecxExtensions.routeOf(path)
            ?: throw IllegalArgumentException("Unknown endpoint: $path")
        return route.invoke(api, DecxRequestParams(payload))
    }

    fun pathToKind(path: String): String {
        val builtin = DecxRoutes.kindOf(path)
        if (builtin != "unknown") return builtin
        return DecxExtensions.kindOf(path) ?: "unknown"
    }
}
