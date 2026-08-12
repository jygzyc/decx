package jadx.plugins.decx.taint.worker

import jadx.plugins.decx.taint.protocol.WorkerMessage
import jadx.plugins.decx.taint.protocol.WorkerProtocol
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.nio.charset.StandardCharsets

/**
 * Taint worker process entry point.
 *
 * Speaks NDJSON over stdin/stdout:
 *   - on startup: emits {"type":"ready","pid":...}
 *   - loops: reads analyze/shutdown messages, emits progress/result/error
 *   - on shutdown (or EOF): emits {"type":"bye"} and exits
 *
 * The orchestrator (decx-core TaintWorkerPool) spawns this JVM with an
 * isolated classpath: the Tai-e modified jars under DECX_HOME/tai-e/lib
 * followed by this worker fat jar, and sets the working directory to
 * DECX_HOME/tai-e so Tai-e's relative `java-benchmarks/JREs` resolution
 * works.
 */
fun main() {
    val stdin = BufferedReader(InputStreamReader(System.`in`, StandardCharsets.UTF_8))
    val stdout = PrintWriter(OutputStreamWriter(System.out, StandardCharsets.UTF_8), true)

    fun send(message: WorkerMessage) {
        synchronized(stdout) { WorkerProtocol.write(stdout, message) }
    }

    send(WorkerMessage.ready(ProcessHandle.current().pid()))
    System.err.println("[worker] ready, pid=${ProcessHandle.current().pid()}")

    try {
        while (true) {
            val message = try {
                WorkerProtocol.read(stdin)
            } catch (e: Exception) {
                // Protocol error on stdin: report and keep the worker alive.
                System.err.println("[worker] protocol error: ${e.message}")
                send(WorkerMessage.error(0, "protocol_error", e.message ?: "malformed message"))
                continue
            } ?: break // clean EOF -> exit

            when (message.type) {
                WorkerMessage.TYPE_ANALYZE -> handleAnalyze(message, ::send)
                WorkerMessage.TYPE_SHUTDOWN -> {
                    send(WorkerMessage.bye())
                    break
                }
                else -> send(WorkerMessage.error(message.id, "unsupported", "Unsupported message type: ${message.type}"))
            }
        }
    } catch (e: Throwable) {
        System.err.println("[worker] fatal: ${e.message}")
        runCatching { send(WorkerMessage.error(0, "worker_fatal", e.message ?: "worker crashed")) }
    } finally {
        System.err.println("[worker] exiting")
        runCatching { send(WorkerMessage.bye()) }
        stdout.flush()
    }
}

private fun handleAnalyze(
    message: WorkerMessage,
    send: (WorkerMessage) -> Unit
) {
    val id = message.id
    val apk = message.apk
    val progress = { stage: String, text: String ->
        send(WorkerMessage.progress(id, stage, text))
    }

    if (apk.isNullOrBlank()) {
        send(WorkerMessage.error(id, "invalid_request", "analyze: apk is required"))
        return
    }

    try {
        progress("starting", "analysis started")
        val (flows, meta) = TaiEEngine.analyze(
            apk = apk,
            platforms = message.platforms,
            analysis = message.analysisConfig ?: emptyMap(),
            limits = message.limitsConfig ?: emptyMap(),
            taint = message.taintConfig ?: emptyMap(),
            raw = message.rawConfig,
            progress = progress
        )
        send(WorkerMessage.result(id, flows, meta))
    } catch (e: Throwable) {
        System.err.println("[worker] analyze error: ${e.message}")
        send(WorkerMessage.error(id, "analysis_failed", e.message ?: "analysis failed"))
    }
}
