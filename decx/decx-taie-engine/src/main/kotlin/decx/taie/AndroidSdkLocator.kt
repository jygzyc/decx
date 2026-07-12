package decx.taie

import java.io.File

/**
 * Locates the Android SDK platform jars (`android.jar`) required by Tai-e's
 * Android mode (`-ajs`).
 *
 * Resolution priority:
 *   1. `ANDROID_HOME` environment variable
 *   2. `ANDROID_SDK_ROOT` environment variable
 *   3. Common default locations (best-effort)
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
     * @return the path to pass as `-ajs`, or null if no SDK was found.
     */
    fun locatePlatformsDir(): String? {
        val sdkRoot = findSdkRoot() ?: return null
        val platformsDir = File(sdkRoot, "platforms")
        if (!platformsDir.isDirectory) return null
        return platformsDir.absolutePath
    }

    internal fun findSdkRoot(): String? {
        System.getenv("ANDROID_HOME")?.let { env ->
            if (File(env).isDirectory) return env
        }
        System.getenv("ANDROID_SDK_ROOT")?.let { env ->
            if (File(env).isDirectory) return env
        }
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
}
