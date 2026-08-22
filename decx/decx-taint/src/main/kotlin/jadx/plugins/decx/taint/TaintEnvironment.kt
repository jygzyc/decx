package jadx.plugins.decx.taint

import java.io.File

/**
 * Runtime environment for the taint engine.
 *
 * Layout (production, installed via `decx self install tai-e`):
 *   DECX_HOME/tai-e/lib/          every jar of the Tai-e official dist
 *                                 (tai-e jar + patched Soot/FlowDroid jars
 *                                 + their runtime dependencies)
 *   DECX_HOME/tai-e/worker/decx-taint-worker.jar              (worker fat jar)
 *   DECX_HOME/tai-e/java-benchmarks/JREs/jre1.X/               (JRE libs)
 *   DECX_HOME/platforms/android-XX/android.jar                 (Android platforms)
 *
 * Dev fallbacks (this module's build output, relative to the server cwd) keep
 * the extension usable in a checkout without a prior `self install`:
 *   decx-taint/build/taie/lib/     (FetchTaiETask extraction)
 *   decx-taint/build/libs/decx-taint-worker.jar
 *
 * java-benchmarks / platforms are deliberately NOT shipped in any jar: they
 * are large, platform-specific, and installed separately (tai-e upstream
 * repo / Android SDK). Readiness reporting surfaces what is missing.
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
    }

    val taiEDir: File get() = File(decxHome, "tai-e")
    val libDir: File get() = File(taiEDir, "lib")
    val workerDir: File get() = File(taiEDir, "worker")
    val defaultPlatforms: File get() = File(decxHome, "platforms")

    // ------------------------------------------------------------------
    // Dev fallback root (used when the DECX_HOME layout is absent)
    // ------------------------------------------------------------------

    private val devModuleRoot: File? get() = resolveDevModuleRoot()

    private fun resolveDevModuleRoot(): File? {
        if (!useDevFallback) return null
        val candidates = listOf(
            File("decx-taint"),            // cwd = decx/
            File("decx/decx-taint"),       // cwd = repo root
            File("../decx-taint"),         // cwd = decx/ sibling subdir
            File("../../decx-taint")
        )
        return candidates.firstOrNull { File(it, "build").isDirectory }
    }

    // ------------------------------------------------------------------
    // Resolved assets
    // ------------------------------------------------------------------

    fun workerJar(): File {
        System.getenv("DECX_TAINT_WORKER_JAR")?.takeIf { File(it).isFile }?.let { return File(it) }
        val installed = File(workerDir, "decx-taint-worker.jar")
        if (installed.isFile) return installed
        devModuleRoot?.let { root ->
            val dev = File(root, "build/libs/decx-taint-worker.jar")
            if (dev.isFile) return dev
        }
        return installed
    }

    /** Full Tai-e runtime classpath: every jar in the lib dir. */
    fun taieLibJars(): List<File> {
        val installed = libDir.listFiles { f -> f.isFile && f.name.endsWith(".jar") }.orEmpty()
        if (installed.isNotEmpty()) return installed.sortedBy { it.name }
        devModuleRoot?.let { root ->
            val dev = File(root, "build/taie/lib").listFiles { f -> f.isFile && f.name.endsWith(".jar") }.orEmpty()
            if (dev.isNotEmpty()) return dev.sortedBy { it.name }
        }
        return emptyList()
    }

    /** Worker process working directory (Tai-e resolves java-benchmarks/JREs from cwd). */
    fun workerWorkingDir(): File {
        val jres = File(taiEDir, "java-benchmarks/JREs")
        if (jres.isDirectory && (jres.listFiles()?.isNotEmpty() == true)) return taiEDir
        devModuleRoot?.let { root ->
            val devJres = File(root, "java-benchmarks/JREs")
            if (devJres.isDirectory && (devJres.listFiles()?.isNotEmpty() == true)) return root
        }
        return taiEDir
    }

    /** Platforms dir: user override or DECX_HOME/platforms (may not exist yet). */
    fun platformsDir(requested: String?): File? {
        if (!requested.isNullOrBlank()) return File(requested)
        return defaultPlatforms.takeIf { it.isDirectory }
    }

    // ------------------------------------------------------------------
    // Readiness
    // ------------------------------------------------------------------

    fun isWorkerReady(): Boolean = workerJar().isFile && taieLibJars().isNotEmpty()

    fun hasJres(): Boolean = File(workerWorkingDir(), "java-benchmarks/JREs").listFiles()?.isNotEmpty() == true

    fun isReady(): Boolean = isWorkerReady() && hasJres()

    fun status(): Map<String, Any> {
        val jresDir = File(workerWorkingDir(), "java-benchmarks/JREs")
        return linkedMapOf<String, Any>(
            "decxHome" to decxHome.absolutePath,
            "workerJar" to workerJar().absolutePath,
            "workerJarExists" to workerJar().isFile,
            "taieLibJars" to taieLibJars().map { it.name },
            "jres" to (jresDir.listFiles()?.map { it.name } ?: emptyList<Any>()),
            "platforms" to (defaultPlatforms.listFiles()?.map { it.name } ?: emptyList<Any>()),
            "ready" to isReady()
        )
    }
}
