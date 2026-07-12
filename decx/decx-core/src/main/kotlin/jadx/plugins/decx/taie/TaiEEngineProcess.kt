package jadx.plugins.decx.taie

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.atomic.AtomicReference
import java.util.logging.Level
import java.util.logging.Logger

/**
 * Manages the TaiEEngine process lifecycle: spawn, monitor, and clean shutdown.
 *
 * The TaiEEngine runs as a separate JVM process with its own -Xmx, completely
 * isolating Tai-e's memory from JADX's heap. Communication with the process
 * is via stdin/stdout JSON-RPC (see [TaiEEngineClient]).
 *
 * The engine jar is embedded as a classpath resource (`/decx-taie-engine.jar`)
 * inside decx-core. On first use, it is extracted to a temp directory and
 * cached. This means server.jar and plugin.jar both carry the engine without
 * needing a separate download — there are only two release artifacts.
 *
 * Usage:
 * ```kotlin
 * val process = TaiEEngineProcess(apkFile, rulesDir, xmx)
 * val client = process.start() // extracts engine jar, spawns process
 * // ... use client ...
 * process.stop()
 * ```
 *
 * Alternatively, for testing with a specific jar path:
 * ```kotlin
 * val process = TaiEEngineProcess(apkFile, rulesDir, xmx, engineJarPath = "/path/to/jar")
 * ```
 */
class TaiEEngineProcess private constructor(
    private val engineJarPath: String,
    private val apkFile: File,
    private val rulesDir: File?,
    private val androidJarsDir: String?,
    private val xmx: String,
    private val outputDir: File,
    private val logFile: File?
) {
    private val logger = Logger.getLogger("TaiEEngineProcess")

    private val processRef = AtomicReference<Process?>(null)
    private val clientRef = AtomicReference<TaiEEngineClient?>(null)

    /**
     * Spawns the TaiEEngine process and returns a [TaiEEngineClient] for IPC.
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

        // Monitor thread to detect process crash
        Thread({
            val exitCode = process.waitFor()
            logger.info("TaiEEngine process exited with code $exitCode")
            client.close()
        }, "TaiEEngine-Monitor").apply { isDaemon = true }.start()

        return client
    }

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

    fun isAlive(): Boolean = processRef.get()?.isAlive == true

    companion object {
        private const val EMBEDDED_JAR_RESOURCE = "/decx-taie-engine.jar"
        private const val EXTRACTED_JAR_NAME = "decx-taie-engine.jar"

        /**
         * Creates a TaiEEngineProcess using the engine jar embedded in core's
         * classpath. The jar is extracted to a temp directory on first use
         * and cached for subsequent runs.
         */
        fun create(
            apkFile: File,
            rulesDir: File? = null,
            androidJarsDir: String? = null,
            xmx: String = "4G",
            outputDir: File = File(System.getProperty("java.io.tmpdir"), "decx-taie-engine"),
            logFile: File? = null
        ): TaiEEngineProcess {
            val jarPath = extractEmbeddedEngineJar()
            return TaiEEngineProcess(jarPath, apkFile, rulesDir, androidJarsDir, xmx, outputDir, logFile)
        }

        /**
         * Creates a TaiEEngineProcess with an explicit engine jar path.
         * Used for testing or when the jar is in a known location.
         */
        fun createWithJar(
            engineJarPath: String,
            apkFile: File,
            rulesDir: File? = null,
            androidJarsDir: String? = null,
            xmx: String = "4G",
            outputDir: File = File(System.getProperty("java.io.tmpdir"), "decx-taie-engine"),
            logFile: File? = null
        ): TaiEEngineProcess {
            return TaiEEngineProcess(engineJarPath, apkFile, rulesDir, androidJarsDir, xmx, outputDir, logFile)
        }

        /**
         * Extracts the embedded engine jar from the classpath to a cached temp
         * location. Returns the path to the extracted jar file.
         */
        private fun extractEmbeddedEngineJar(): String {
            val cacheDir = File(System.getProperty("java.io.tmpdir"), "decx-taie-cache")
            cacheDir.mkdirs()
            val jarFile = File(cacheDir, EXTRACTED_JAR_NAME)

            // Check if already extracted (skip if exists and non-empty)
            if (jarFile.exists() && jarFile.length() > 0) {
                return jarFile.absolutePath
            }

            // Extract from classpath resource
            val resourceStream: InputStream = TaiEEngineProcess::class.java
                .getResourceAsStream(EMBEDDED_JAR_RESOURCE)
                ?: throw IllegalStateException(
                    "TaiEEngine jar not found in classpath ($EMBEDDED_JAR_RESOURCE). " +
                    "Ensure decx-core was built with the embedTaieEngine task."
                )

            Files.copy(resourceStream, jarFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
            resourceStream.close()

            logger().info("Extracted TaiEEngine jar to ${jarFile.absolutePath}")
            return jarFile.absolutePath
        }

        private fun logger() = Logger.getLogger("TaiEEngineProcess")
    }
}
