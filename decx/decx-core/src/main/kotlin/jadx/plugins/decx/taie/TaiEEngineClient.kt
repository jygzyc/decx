package jadx.plugins.decx.taie

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.reflect.TypeToken
import jadx.plugins.decx.service.ITaiEEngine
import jadx.plugins.decx.service.ITaiEEngine.CallEdge
import jadx.plugins.decx.service.ITaiEEngine.RuleSummary
import jadx.plugins.decx.service.ITaiEEngine.RuleParameter
import jadx.plugins.decx.service.ITaiEEngine.TaintPath
import jadx.plugins.decx.service.ITaiEEngine.TaintStep
import jadx.plugins.decx.service.ITaiEEngine.DynamicReceiverInfo
import jadx.plugins.decx.service.ITaiEEngine.IccTarget
import jadx.plugins.decx.service.ITaiEEngine.CallbackInfo
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * IPC client implementing [ITaiEEngine].
 *
 * Communicates with the TaiEEngine process (decx-taie-engine) over stdin/stdout
 * using the Content-Length JSON-RPC protocol defined in [TaiEEngineProtocol].
 *
 * Each [ITaiEEngine] method sends a JSON-RPC request and blocks for the response
 * (with timeout). A background reader thread dispatches responses to pending
 * futures and processes notifications (ready/error/status).
 *
 * If the engine process crashes, [isReady] flips to false and all pending
 * requests complete exceptionally, causing DECX to fall back to JADX.
 */
class TaiEEngineClient(
    private val processInput: OutputStream,
    private val processOutput: java.io.InputStream,
    private val onReady: () -> Unit = {},
    private val onError: (String) -> Unit = {}
) : ITaiEEngine, AutoCloseable {

    private val gson = Gson()
    private val nextId = AtomicLong(1)
    private val ready = AtomicBoolean(false)
    private val analysisReady = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)

    // Pending requests: id -> future that completes with the JsonElement result
    private val pending = ConcurrentHashMap<Long, CompletableFuture<com.google.gson.JsonElement>>()

    private val readerThread = Thread(::readerLoop, "TaiEEngine-Reader").apply {
        isDaemon = true
        start()
    }

    override val isReady: Boolean get() = ready.get()
    override val isAnalysisReady: Boolean get() = analysisReady.get()

    // ------------------------------------------------------------------
    // Reader loop: reads framed messages and dispatches
    // ------------------------------------------------------------------

    private fun readerLoop() {
        val reader = BufferedReader(InputStreamReader(processOutput, StandardCharsets.UTF_8))
        try {
            while (!closed.get()) {
                val json = TaiEEngineProtocol.readMessage(reader) ?: break
                val msg = TaiEEngineProtocol.parseMessage(json)

                if (msg.method != null) {
                    // Notification (no id): ready, error, status, progress
                    handleNotification(msg.method, msg.params)
                } else if (msg.id != null) {
                    // Response to a request
                    val id = msg.id.toString().toLongOrNull()
                    if (id != null) {
                        val future = pending.remove(id)
                        if (future != null) {
                            if (msg.error != null) {
                                future.completeExceptionally(
                                    TaiEEngineException(msg.error.get("message")?.asString ?: "unknown error")
                                )
                            } else {
                                future.complete(msg.result ?: JsonObject())
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            if (!closed.get()) {
                onError("TaiEEngine reader error: ${e.message}")
            }
        } finally {
            // Process died or stream closed — fail all pending
            ready.set(false)
            analysisReady.set(false)
            pending.values.forEach { it.completeExceptionally(TaiEEngineException("engine process terminated")) }
            pending.clear()
        }
    }

    private fun handleNotification(method: String, params: JsonObject?) {
        when (method) {
            "ready" -> {
                ready.set(true)
                val ar = params?.get("analysisReady")?.asBoolean ?: false
                analysisReady.set(ar)
                onReady()
            }
            "error" -> {
                val msg = params?.get("message")?.asString ?: "unknown"
                onError(msg)
            }
            "status" -> {
                // Progress/status updates — could be logged
            }
        }
    }

    // ------------------------------------------------------------------
    // Request helper
    // ------------------------------------------------------------------

    private fun sendRequest(method: String, params: Map<String, Any?> = emptyMap(), timeoutSeconds: Long = 30): com.google.gson.JsonElement {
        if (!ready.get() && method != "getStatus") {
            throw TaiEEngineException("TaiEEngine not ready")
        }
        val id = nextId.getAndIncrement()
        val future = CompletableFuture<com.google.gson.JsonElement>()
        pending[id] = future

        val requestJson = TaiEEngineProtocol.request(id, method, params)
        TaiEEngineProtocol.writeMessage(processInput, requestJson)

        return try {
            future.get(timeoutSeconds, TimeUnit.SECONDS)
        } catch (e: Exception) {
            pending.remove(id)
            throw TaiEEngineException("Request '$method' failed: ${e.message}", e)
        }
    }

    // Inline helper for simple list-returning requests
    private inline fun <reified T> sendListRequest(method: String, params: Map<String, Any?> = emptyMap(), timeoutSeconds: Long = 30): List<T> {
        val result = sendRequest(method, params, timeoutSeconds)
        val type = TypeToken.getParameterized(List::class.java, T::class.java).type
        return gson.fromJson(result, type) ?: emptyList()
    }

    private fun sendStringListRequest(method: String, params: Map<String, Any?> = emptyMap()): List<String> =
        sendListRequest(method, params)

    // ------------------------------------------------------------------
    // ITaiEEngine implementation
    // ------------------------------------------------------------------

    override fun callersOf(methodSig: String): List<CallEdge> =
        sendListRequest("callersOf", mapOf("methodSig" to methodSig))

    override fun calleesOf(methodSig: String): List<CallEdge> =
        sendListRequest("calleesOf", mapOf("methodSig" to methodSig))

    override fun subclassesOf(classSig: String, transitive: Boolean): List<String> =
        sendStringListRequest("subclassesOf", mapOf("classSig" to classSig, "transitive" to transitive))

    override fun implementorsOf(ifaceSig: String, transitive: Boolean): List<String> =
        sendStringListRequest("implementorsOf", mapOf("ifaceSig" to ifaceSig, "transitive" to transitive))

    override fun getRules(): List<RuleSummary> =
        sendListRequest("getRules")

    override fun investigate(ruleId: String, params: Map<String, String>): List<TaintPath> =
        sendListRequest("investigate", mapOf("ruleId" to ruleId, "params" to params), timeoutSeconds = 600)

    override fun investigateCustom(ruleYaml: String, params: Map<String, String>): List<TaintPath> =
        sendListRequest("investigateCustom", mapOf("ruleYaml" to ruleYaml, "params" to params), timeoutSeconds = 600)

    override fun pointsTo(methodSig: String, varName: String): List<String> =
        sendStringListRequest("pointsTo", mapOf("methodSig" to methodSig, "varName" to varName))

    override fun dynamicReceivers(): List<DynamicReceiverInfo> =
        sendListRequest("dynamicReceivers")

    override fun iccTargets(componentSig: String): List<IccTarget> =
        sendListRequest("iccTargets", mapOf("componentSig" to componentSig))

    override fun registeredCallbacks(componentSig: String): List<CallbackInfo> =
        sendListRequest("registeredCallbacks", mapOf("componentSig" to componentSig))

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    override fun close() {
        closed.set(true)
        pending.values.forEach { it.completeExceptionally(TaiEEngineException("client closed")) }
        pending.clear()
    }
}

class TaiEEngineException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
