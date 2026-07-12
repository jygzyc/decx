package jadx.plugins.decx.taie

import java.io.File
import java.util.concurrent.atomic.AtomicReference
import java.util.logging.Level
import java.util.logging.Logger

/**
 * Manages the TaiEEngine process lifecycle: spawn, monitor, and clean shutdown.
 *
 * The TaiEEngine runs as a separate JVM process (decx-taie-engine.jar) with its
 * own -Xmx, completely isolating Tai-e's memory from JADX's heap. Communication
 * with the process is via stdin/stdout JSON-RPC (see [TaiEEngineClient]).
 *
 * Usage:
 * ```kotlin
 * val manager = TaiEEngineProcess(jarPath, apkFile, rulesDir, xmx)
 * val client = manager.start() // spawns process, returns ITaiEEngine client
 * // ... use client ...
 * manager.stop() // kills process
 * ```
 */
class TaiEEngineProcess(
    private val engineJarPath: String,
    private val apkFile: File,
    private val rulesDir: File? = null,
    private val androidJarsDir: String? = null,
    private val xmx: String = "4G",
    private val outputDir: File = File(System.getProperty("java.io.tmpdir"), "decx-taie-engine"),
    private val logFile: File? = null
) {
    private val logger = Logger.getLogger("TaiEEngineProcess")

    private val processRef = AtomicReference<Process?>(null)
    private val clientRef = AtomicReference<TaiEEngineClient?>(null)

    /**
     * Spawns the TaiEEngine process and returns an [TaiEEngineClient] for IPC.
     *
     * The client's [ITaiEEngine.isReady] will be false until the engine sends
     * a "ready" notification (after World construction + PTA completes).
     */
    fun start(): TaiEEngineClient {
        outputDir.mkdirs()

        val args = buildList {
            add(System.getProperty("java.home") + "/bin/java")
            add("-Xmx$xmx")
            add("-jar")
            add(engineJarPath)
            add("--apk")
            add(apkFile.absolutePath)
            if (rulesDir != null) {
                add("--rules-dir")
                add(rulesDir.absolutePath)
            }
            if (androidJarsDir != null) {
                add("--android-jars")
                add(androidJarsDir)
            }
            add("--output-dir")
            add(outputDir.absolutePath)
        }

        logger.info("Starting TaiEEngine: ${args.joinToString(" ")}")

        val pb = ProcessBuilder(args)
        // stderr → log file (never mix into stdout protocol stream)
        val actualLogFile = logFile ?: File(outputDir, "taie-engine.log")
        pb.redirectError(actualLogFile)

        val process = pb.start()
        processRef.set(process)

        val client = TaiEEngineClient(
            processInput = process.outputStream,
            processOutput = process.inputStream,
            onReady = { logger.info("TaiEEngine is ready") },
            onError = { msg -> logger.warning("TaiEEngine error: $msg") }
        )
        clientRef.set(client)

        // Start a monitor thread to detect process crash
        Thread({
            val exitCode = process.waitFor()
            logger.info("TaiEEngine process exited with code $exitCode")
            client.close()
        }, "TaiEEngine-Monitor").apply { isDaemon = true }.start()

        return client
    }

    /**
     * Kills the TaiEEngine process and cleans up.
     */
    fun stop() {
        clientRef.get()?.close()
        processRef.getAndSet(null)?.let { process ->
            process.descendants().forEach { it.destroy() }
            process.destroy()
            if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly()
            }
        }
    }

    /**
     * Returns true if the process is alive.
     */
    fun isAlive(): Boolean = processRef.get()?.isAlive == true
}
