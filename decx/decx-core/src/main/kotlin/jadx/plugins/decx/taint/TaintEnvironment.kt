package jadx.plugins.decx.taint

import java.io.File

/**
 * Runtime environment for the taint engine.
 *
 * Layout (production, installed via `decx self install tai-e`):
 *   DECX_HOME/tai-e/lib/sootclasses-modified.jar          (Tai-e patches)
 *   DECX_HOME/tai-e/lib/flowdroidclasses-modified.jar
 *   DECX_HOME/tai-e/worker/decx-taint-worker.jar          (worker fat jar)
 *   DECX_HOME/tai-e/java-benchmarks/JREs/jre1.X/          (JRE libs)
 *   DECX_HOME/platforms/android-XX/android.jar            (Android platforms)
 *
 * Dev fallbacks (sibling module build output, relative to server cwd) keep
 * the extension usable in a checkout without a prior `self install`.
 *
 * java-benchmarks / platforms are deliberately NOT shipped in any jar: they
 * are downloaded/installed on demand (see AGENTS.md design decision).
 */
class TaintEnvironment(
    val decxHome: File = defaultDecxHome(),
    /** When true (default), dev module build output is used as a fallback when
     *  the DECX_HOME layout is incomplete. Tests set this to false to keep
     *  the environment fully deterministic. */
    private val useDevFallback: Boolean = true
) {

    companion object {
        fun defaultDecxHome(): File {
            val env = System.getenv("DECX_HOME")
            if (!env.isNullOrBlank()) return File(env)
            return File(System.getProperty("user.home"), ".decx")
        }

        private const val WORKER_MAIN = "jadx.plugins.decx.taint.worker.TaintWorkerMainKt"
    }

    val taiEDir: File get() = File(decxHome, "tai-e")
    val libDir: File get() = File(taiEDir, "lib")
    val workerDir: File get() = File(taiEDir, "worker")
    val jresDir: File get() = File(taiEDir, "java-benchmarks/JREs")
    val defaultPlatforms: File get() = File(decxHome, "platforms")

    // ------------------------------------------------------------------
    // Dev fallback roots (used when DECX_HOME layout is absent)
    // ------------------------------------------------------------------

    private val devPocRoot: File? get() = resolveDevDir("decx-taint-poc")
    private val devWorkerRoot: File? get() = resolveDevDir("decx-taint-worker")

    private fun resolveDevDir(module: String): File? {
        if (!useDevFallback) return null
        val candidates = listOf(
            File("decx/$module/build/libs").parentFile,    // cwd = repo root
            File("$module/build/libs").parentFile,          // cwd = decx/
            File("../$module/build/libs").parentFile,       // cwd = decx/ subdir
            File("../../$module/build/libs").parentFile
        )
        return candidates.firstOrNull { it.isDirectory }
    }

    // ------------------------------------------------------------------
    // Resolved assets
    // ------------------------------------------------------------------

    fun workerJar(): File {
        System.getenv("DECX_TAINT_WORKER_JAR")?.takeIf { File(it).isFile }?.let { return File(it) }
        val installed = File(workerDir, "decx-taint-worker.jar")
        if (installed.isFile) return installed
        devWorkerRoot?.let { root ->
            val dev = File(root, "build/libs/decx-taint-worker-all.jar")
            if (dev.isFile) return dev
        }
        return installed
    }

    fun modifiedJars(): List<File> {
        val installed = libDir.listFiles { f -> f.isFile && f.name.endsWith("-modified.jar") }.orEmpty()
        if (installed.isNotEmpty()) return installed.sortedBy { it.name }
        devPocRoot?.let { root ->
            val dev = File(root, "lib").listFiles { f -> f.isFile && f.name.endsWith("-modified.jar") }.orEmpty()
            if (dev.isNotEmpty()) return dev.sortedBy { it.name }
        }
        return emptyList()
    }

    /** Directory with java-benchmarks/JREs relative to worker cwd. */
    fun jresRoot(): File {
        val installed = taiEDir
        if (File(installed, "java-benchmarks/JREs").isDirectory) return installed
        devPocRoot?.let { root ->
            if (File(root, "java-benchmarks/JREs").isDirectory) return root
        }
        return installed
    }

    /** Worker process working directory (Tai-e resolves java-benchmarks/JREs from cwd). */
    fun workerWorkingDir(): File = jresRoot()

    /** Platforms dir: user override or DECX_HOME/platforms (may not exist yet). */
    fun platformsDir(requested: String?): File? {
        if (!requested.isNullOrBlank()) return File(requested)
        return defaultPlatforms.takeIf { it.isDirectory }
    }

    // ------------------------------------------------------------------
    // Readiness
    // ------------------------------------------------------------------

    fun isWorkerReady(): Boolean = workerJar().isFile && modifiedJars().isNotEmpty()

    fun hasJres(): Boolean = File(jresRoot(), "java-benchmarks/JREs").listFiles()?.isNotEmpty() == true

    fun isReady(): Boolean = isWorkerReady() && hasJres()

    fun status(): Map<String, Any> {
        val jres = File(jresRoot(), "java-benchmarks/JREs").listFiles()?.map { it.name } ?: emptyList()
        return linkedMapOf<String, Any>(
            "decxHome" to decxHome.absolutePath,
            "workerJar" to workerJar().absolutePath,
            "workerJarExists" to workerJar().isFile,
            "modifiedJars" to modifiedJars().map { it.name },
            "jres" to jres,
            "platforms" to (defaultPlatforms.listFiles()?.map { it.name } ?: emptyList()),
            "ready" to isReady()
        )
    }
}
