package jadx.plugins.decx.server

import io.javalin.Javalin
import io.javalin.http.Context
import io.javalin.http.bodyAsClass
import jadx.api.JadxDecompiler
import jadx.plugins.decx.DecxConstants
import jadx.plugins.decx.api.DecxApi
import jadx.plugins.decx.api.DecxRoutes
import jadx.plugins.decx.api.DecxApiImpl
import jadx.plugins.decx.utils.DecompileGuard
import jadx.plugins.decx.utils.RouteTelemetry
import jadx.plugins.decx.utils.LogUtils
import jadx.plugins.decx.utils.PluginUtils
import jadx.plugins.decx.utils.ThreadPoolUtils
import jadx.plugins.decx.api.DecxError
import jadx.plugins.decx.utils.AnalysisResultUtils
import java.util.concurrent.ExecutionException
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * HTTP server built on Javalin. Delegates all business logic to [DecxApi].
 *
 * Used by both standalone server and plugin mode.
 */
class DecxServer(
    private val api: DecxApi,
    private val port: Int = DecxConstants.DEFAULT_PORT
) {

    /** If set, this MCP server is automatically stopped when the HTTP server stops. */
    var mcpServer: DecxMcpServer? = null

    companion object {
        private const val RESTART_DELAY_MS = 2000L
        private const val HEALTH_KIND = "health"
        private const val DEFAULT_REQUEST_TIMEOUT_MS = 120_000L
        private const val ROUTE_THREAD_CAP = 8

        /** Create a DecxServer directly from a decompiler instance. */
        fun create(decompiler: JadxDecompiler, port: Int = DecxConstants.DEFAULT_PORT): DecxServer {
            return DecxServer(DecxApiImpl(decompiler), port)
        }
    }

    val isRunning: Boolean get() = started

    private var app: Javalin? = null
    private var routeHandler: RouteHandler? = null
    private var routeExecutor = ThreadPoolUtils.createNamedDaemonPool("DecxServer-Route", ROUTE_THREAD_CAP)
    private val requestTimeoutMs = java.lang.Long.getLong("decx.requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS)

    @Volatile
    private var started = false

    @Volatile
    private var shutdownHook: Thread? = null

    @Synchronized
    fun start(overridePort: Int = port): Boolean {
        if (started) {
            LogUtils.warn("Server is running")
            return true
        }

        return try {
            routeHandler = RouteHandler(api)
            app = Javalin.create { config ->
                config.startup.showJavalinBanner = false
                config.routes.get("/health") { ctx -> handleHealthCheck(ctx) }
                DecxRoutes.all.forEach { route ->
                    config.routes.post(route.path) { ctx -> handleRoute(ctx, route.path) }
                }
            }.start(overridePort)
            started = true

            LogUtils.info("Server started on port $overridePort")
            setupShutdownHook()
            RouteTelemetry.startLogger()
            true
        } catch (e: Exception) {
            started = false
            LogUtils.error(DecxError.SERVER_INTERNAL_ERROR, e, "Start failed")
            false
        }
    }

    @Synchronized
    fun stop(): Boolean {
        if (!started) return true

        started = false

        return try {
            RouteTelemetry.stopLogger()
            mcpServer?.stop()
            app?.stop()
            app = null
            routeExecutor.shutdownNow()
            routeExecutor = ThreadPoolUtils.createNamedDaemonPool("DecxServer-Route", ROUTE_THREAD_CAP)
            LogUtils.info("Server stopped")
            true
        } catch (e: Exception) {
            LogUtils.error(DecxError.SERVER_INTERNAL_ERROR, e, "Stop failed")
            false
        } finally {
            removeShutdownHook()
        }
    }

    fun restart(): Boolean {
        if (!started) {
            LogUtils.info("Starting server...")
            return start()
        }

        Thread({
            try {
                DecompileGuard.reset()
                RouteTelemetry.reset()
                LogUtils.info("Restarting server...")
                stop()
                Thread.sleep(RESTART_DELAY_MS)
                start()
            } catch (e: Exception) {
                LogUtils.error(DecxError.SERVER_INTERNAL_ERROR, e, "Restart failed")
                started = false
            }
        }, "DecxServer-Restart").apply {
            isDaemon = true
        }.start()
        return true
    }

    fun handleHealthCheck(ctx: Context) {
        try {
            ctx.json(
                mapOf(
                    "status" to if (started) "running" else "stopped",
                    "version" to DecxConstants.getVersion(),
                    "url" to PluginUtils.buildServerUrl(port = port, running = started),
                    "port" to port,
                    "timestamp" to System.currentTimeMillis(),
                    "active_operations" to RouteTelemetry.activeSnapshot(),
                    "endpoint_stats" to RouteTelemetry.statsSnapshot(),
                    "cache" to listOf(DecompileGuard.stats())
                )
            )
        } catch (e: Exception) {
            LogUtils.error(DecxError.HEALTH_CHECK_FAILED, e)
            ctx.status(DecxError.HEALTH_CHECK_FAILED.status).json(
                AnalysisResultUtils.error(
                    kind = HEALTH_KIND,
                    code = DecxError.HEALTH_CHECK_FAILED.code,
                    message = DecxError.HEALTH_CHECK_FAILED.format(e.message ?: "unknown")
                )
            )
        }
    }

    /**
     * Expose the underlying [DecxApi] for direct access without going through HTTP.
     */
    fun getApi(): DecxApi = api

    private fun handleRoute(ctx: Context, path: String) {
        val opId = RouteTelemetry.begin(path)
        val start = System.nanoTime()
        var future: Future<Map<String, Any>>? = null
        var outcome = RouteTelemetry.Outcome.SUCCESS
        try {
            val payload = readPayload(ctx)
            future = routeExecutor.submit<Map<String, Any>> {
                RouteTelemetry.bindThread(opId)
                try {
                    executeRoute(path, payload)
                } finally {
                    RouteTelemetry.unbindThread()
                }
            }
            val response = future.get(requestTimeoutMs, TimeUnit.MILLISECONDS)
            ctx.json(response)
        } catch (e: TimeoutException) {
            future?.cancel(true)
            outcome = RouteTelemetry.Outcome.TIMEOUT
            handleRouteTimeout(ctx, path)
        } catch (e: ExecutionException) {
            outcome = RouteTelemetry.Outcome.ERROR
            handleRouteError(ctx, e.cause as? Exception ?: e, path)
        } catch (e: Exception) {
            outcome = RouteTelemetry.Outcome.ERROR
            handleRouteError(ctx, e, path)
        } finally {
            val elapsedMs = (System.nanoTime() - start) / 1_000_000L
            RouteTelemetry.complete(path, opId, elapsedMs, outcome)
        }
    }

    private fun executeRoute(path: String, payload: Map<String, Any>): Map<String, Any> {
        val page = payload["page"] as? Int ?: 1
        val handler = routeHandler ?: throw IllegalStateException("RouteHandler not initialized")
        return handler.handle(path, payload, page)
    }

    private fun handleRouteTimeout(ctx: Context, path: String) {
        val message = DecxError.REQUEST_TIMEOUT.format(requestTimeoutMs, path)
        ctx.status(DecxError.REQUEST_TIMEOUT.status).json(
            AnalysisResultUtils.error(
                kind = routeHandler?.pathToKind(path) ?: "unknown",
                code = DecxError.REQUEST_TIMEOUT.code,
                message = message
            )
        )
        LogUtils.warn(message)
    }

    private fun handleRouteError(ctx: Context, e: Exception, path: String) {
        val decxError = when (e) {
            is IllegalArgumentException -> {
                if (e.message?.startsWith("Unknown endpoint") == true) DecxError.UNKNOWN_ENDPOINT else DecxError.INVALID_PARAMETER
            }
            is NoSuchMethodException -> DecxError.METHOD_NOT_FOUND
            is IllegalStateException -> DecxError.SERVICE_ERROR
            else -> DecxError.SERVER_INTERNAL_ERROR
        }
        val detail = e.message ?: path
        val message = decxError.format(detail)

        ctx.status(decxError.status).json(
            AnalysisResultUtils.error(
                kind = routeHandler?.pathToKind(path) ?: "unknown",
                code = decxError.code,
                message = message
            )
        )
        LogUtils.error(decxError, e, detail)
    }

    private fun readPayload(ctx: Context): Map<String, Any> {
        if (ctx.body().isBlank()) {
            return emptyMap()
        }
        return ctx.bodyAsClass()
    }

    private fun setupShutdownHook() {
        shutdownHook = Thread({
            try {
                stop()
            } catch (e: Exception) {
                LogUtils.error(DecxError.SERVER_INTERNAL_ERROR, e, "Stop failed")
            }
        }, "DecxServer-ShutdownHook")
        Runtime.getRuntime().addShutdownHook(shutdownHook)
    }

    private fun removeShutdownHook() {
        val hook = shutdownHook ?: return
        try {
            if (Thread.currentThread().name != "DecxServer-ShutdownHook") {
                Runtime.getRuntime().removeShutdownHook(hook)
            }
        } catch (e: Exception) {
            // ignore
        } finally {
            shutdownHook = null
        }
    }

}
