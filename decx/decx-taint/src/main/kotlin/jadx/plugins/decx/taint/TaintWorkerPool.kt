package jadx.plugins.decx.taint

import jadx.plugins.decx.taint.config.TaintConfig
import jadx.plugins.decx.taint.protocol.TaintFlowDto
import jadx.plugins.decx.taint.protocol.WorkerMessage
import jadx.plugins.decx.taint.protocol.WorkerProtocol
import java.io.Closeable
import java.io.File
import java.util.concurrent.atomic.AtomicLong

/** A single taint analysis request handed to the worker pool. */
data class AnalyzeRequest(
    val id: Long,
    val apk: String,
    val platforms: String?,
    val config: TaintConfig,
    /** Compiled rule set (Tai-e taint fragment) produced by TaintRuleCompiler. */
    val taintFragment: Map<String, Any>
) {
    fun toWorkerMessage(): WorkerMessage = WorkerMessage.analyze(
        id = id,
        apk = apk,
        platforms = platforms,
        analysis = linkedMapOf(
            "algorithm" to "pta",
            "contextSensitivity" to config.analysis.contextSensitivity,
            "scope" to config.analysis.scope,
            "distinguishStrings" to config.analysis.distinguishStrings
        ),
        limits = linkedMapOf(
            "timeoutSec" to config.limits.timeoutSec,
            "maxPointerAnalyzeTimeSec" to config.limits.maxPointerAnalyzeTimeSec
        ),
        taint = taintFragment,
        raw = null
    )
}

class TaintException(message: String, cause: Throwable? = null) : RuntimeException(message, cause) {
    companion object {
        const val CODE_QUEUE_FULL = "TAINT_QUEUE_FULL"
        const val CODE_CANCELLED = "TAINT_CANCELLED"
    }
}

/**
 * Spawns and drives the taint worker JVM over NDJSON stdin/stdout.
 *
 * Each analyze spawns a fresh worker (the Tai-e world is process-scoped; a
 * worker cannot analyze twice without rebuilding). Worker classpath is
 * isolated: the Tai-e dist jars from DECX_HOME/tai-e/lib, then the worker
 * fat jar — Tai-e never rides inside any shipped DECX jar.
 */
class TaintWorkerPool(
    private val env: TaintEnvironment,
    private val maxMemoryMb: Int = 4096
) : Closeable {

    companion object {
        private const val WORKER_MAIN = "jadx.plugins.decx.taint.worker.TaintWorkerMainKt"
        private const val POLL_INTERVAL_MS = 100L
        private const val READY_TIMEOUT_MS = 30_000L
        private const val SPARE_GRACE_MS = 10_000L
    }

    data class Outcome(val flows: List<TaintFlowDto>, val meta: Map<String, Any>)

    private val idGen = AtomicLong(0)
    @Volatile private var closed = false
    @Volatile private var currentProcess: Process? = null

    fun nextId(): Long = idGen.incrementAndGet()

    /**
     * Run one analysis to completion.
     *
     * @throws TaintException on environment, protocol, timeout, or worker failure
     */
    fun analyze(request: AnalyzeRequest, onProgress: (stage: String, message: String) -> Unit = { _, _ -> }): Outcome {
        check(!closed) { "TaintWorkerPool is closed" }
        if (!env.isWorkerReady()) {
            throw TaintException(
                "Taint worker not installed. Run 'decx self install tai-e' or set DECX_TAINT_WORKER_JAR. " +
                    "Status: ${env.status()}"
            )
        }

        val process = spawn()
        currentProcess = process
        try {
            val stdin = process.outputStream.bufferedWriter(Charsets.UTF_8)
            val stdout = process.inputStream.bufferedReader(Charsets.UTF_8)

            // pump stderr to server log for diagnostics
            val stderrPump = Thread {
                process.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { line ->
                    System.err.println("[taint-worker] $line")
                }
            }.apply { isDaemon = true }.start()

            // wait for ready (bounded)
            val readyDeadline = System.currentTimeMillis() + READY_TIMEOUT_MS
            var ready = false
            while (System.currentTimeMillis() < readyDeadline) {
                if (stdout.ready()) {
                    val line = stdout.readLine() ?: break
                    val msg = WorkerProtocol.decode(line)
                    if (msg.type == WorkerMessage.TYPE_READY) { ready = true; break }
                } else Thread.sleep(POLL_INTERVAL_MS)
            }
            if (!ready) throw TaintException("Worker did not become ready (is the JVM/classpath correct?)")

            WorkerProtocol.write(stdin, request.toWorkerMessage())

            val deadline = System.currentTimeMillis() + request.config.limits.timeoutSec * 1000L + SPARE_GRACE_MS
            while (true) {
                if (System.currentTimeMillis() > deadline) {
                    throw TaintException(
                        "Taint analysis timed out after ${request.config.limits.timeoutSec}s"
                    )
                }
                if (!stdout.ready()) {
                    if (!process.isAlive) {
                        val exit = process.exitValue()
                        throw TaintException("Worker exited unexpectedly (exit=$exit)")
                    }
                    Thread.sleep(POLL_INTERVAL_MS)
                    continue
                }
                val line = stdout.readLine() ?: throw TaintException("Worker closed stdout unexpectedly")
                // Defense in depth: any non-protocol line on stdout (stray logger
                // output that bypassed the logback stderr redirect) is skipped.
                if (!line.trimStart().startsWith("{")) {
                    System.err.println("[taint-worker-stdout] $line")
                    continue
                }
                val msg = WorkerProtocol.decode(line)
                when (msg.type) {
                    WorkerMessage.TYPE_PROGRESS ->
                        onProgress(msg.stage ?: "", msg.message ?: "")
                    WorkerMessage.TYPE_RESULT ->
                        return Outcome(msg.flows, msg.meta)
                    WorkerMessage.TYPE_ERROR ->
                        throw TaintException(msg.message ?: "worker error: ${msg.code}")
                    else -> { /* ignore ready/bye duplicates */ }
                }
            }
        } catch (e: TaintException) {
            throw e
        } catch (e: Exception) {
            throw TaintException("Worker communication failed: ${e.message}", e)
        } finally {
            runCatching { process.destroy() }
            currentProcess = null
        }
    }

    /** Destroy the in-flight worker JVM (used to cancel a running analysis). */
    fun destroyCurrent() {
        currentProcess?.let { process ->
            runCatching { process.destroyForcibly() }
        }
    }

    override fun close() {
        closed = true
        destroyCurrent()
    }

    // ------------------------------------------------------------------
    // Process management
    // ------------------------------------------------------------------

    private fun spawn(): Process {
        val classpath = (
            env.taieLibJars().map { it.absolutePath } + env.workerJar().absolutePath
            ).joinToString(File.pathSeparator)
        val javaBin = File(System.getProperty("java.home"), "bin/java${if (isWindows()) ".exe" else ""}")
            .takeIf { it.isFile }?.absolutePath ?: "java"

        val cmd = buildList {
            add(javaBin)
            add("-Xmx${maxMemoryMb}m")
            add("-cp"); add(classpath)
            add(WORKER_MAIN)
        }
        return ProcessBuilder(cmd)
            .directory(env.workerWorkingDir())
            .redirectErrorStream(false)
            .start()
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name", "").lowercase().contains("win")
}
