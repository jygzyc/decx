package jadx.plugins.decx.server.taie

import java.io.File

/**
 * Locates the Android SDK platform jars (`android.jar`) required by Tai-e's
 * Android mode (`-ajs`).
 *
 * Resolution priority:
 *   1. Explicit `--tai-e-android-jars <dir>` (handled by caller, passed directly)
 *   2. `ANDROID_HOME` environment variable
 *   3. `ANDROID_SDK_ROOT` environment variable
 *   4. Common default locations (best-effort)
 *
 * Within the SDK root, this scans `<root>/platforms/android-N/` directories and
 * returns the platforms directory. Tai-e expects the parent directory of the
 * platform dirs (i.e. `<root>/platforms`), not the individual `android.jar`
 * path — it resolves the jar itself by API level.
 *
 * If no SDK is found, returns null; the caller should then let Tai-e run with
 * phantom classes (lower precision but functional).
 */
object AndroidSdkLocator {

    /**
     * Resolves the Android platform jars directory for Tai-e's `-ajs` option.
     *
     * @return the path to pass as `-ajs`, or null if no SDK was found.
     */
    fun locatePlatformsDir(): String? {
        val sdkRoot = findSdkRoot() ?: return null
        val platformsDir = File(sdkRoot, "platforms")
        if (!platformsDir.isDirectory) return null
        // Tai-e expects the platforms directory; it resolves android.jar by API level.
        return platformsDir.absolutePath
    }

    /**
     * Finds the SDK root directory from environment variables or common locations.
     * Visible for testing.
     */
    internal fun findSdkRoot(): String? {
        // 1. ANDROID_HOME
        System.getenv("ANDROID_HOME")?.let { env ->
            if (File(env).isDirectory) return env
        }
        // 2. ANDROID_SDK_ROOT
        System.getenv("ANDROID_SDK_ROOT")?.let { env ->
            if (File(env).isDirectory) return env
        }
        // 3. Common default locations
        val home = System.getProperty("user.home") ?: return null
        val osName = System.getProperty("os.name").lowercase()
        val candidates = buildList {
            if (osName.contains("win")) {
                add(File(home, "AppData/Local/Android/Sdk"))
                add(File(System.getenv("LOCALAPPDATA") ?: "", "Android/Sdk"))
            } else if (osName.contains("mac")) {
                add(File(home, "Library/Android/sdk"))
            } else {
                add(File(home, "Android/Sdk"))
                add(File(home, ".android-sdk"))
            }
        }
        return candidates.firstOrNull { it.isDirectory }?.absolutePath
    }

    /**
     * Lists available platform API levels in the SDK, for diagnostics.
     * Returns empty list if no platforms found.
     */
    fun listPlatformLevels(): List<Int> {
        val platformsDir = locatePlatformsDir() ?: return emptyList()
        return File(platformsDir).listFiles()
            ?.mapNotNull { dir ->
                // Directory name format: android-<N> (e.g. android-33)
                val name = dir.name
                if (name.startsWith("android-")) {
                    name.removePrefix("android-").toIntOrNull()
                } else null
            }
            ?.sorted()
            ?: emptyList()
    }
}
