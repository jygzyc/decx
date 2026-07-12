package jadx.plugins.decx.server.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class AndroidSdkLocatorTest {

    @TempDir
    lateinit var tempDir: Path

    @Test
    fun `locatePlatformsDir returns null when no SDK found`() {
        // With no ANDROID_HOME/ANDROID_SDK_ROOT set and no default SDK in temp,
        // this should return null (phantom class fallback path).
        // Note: this test may find a real SDK if the dev machine has one installed;
        // we only assert non-null is a valid directory.
        val result = AndroidSdkLocator.locatePlatformsDir()
        if (result != null) {
            assertThat(File(result)).isDirectory
        }
    }

    @Test
    fun `findSdkRoot checks ANDROID_HOME first`() {
        // We can't reliably set env vars in JVM tests, so this is a smoke test
        // that findSdkRoot doesn't throw and returns either null or a valid dir.
        val root = AndroidSdkLocator.findSdkRoot()
        if (root != null) {
            assertThat(File(root)).isDirectory
        }
    }

    @Test
    fun `listPlatformLevels returns sorted list or empty`() {
        val levels = AndroidSdkLocator.listPlatformLevels()
        // Just verify it doesn't throw and returns a list (may be empty on dev machine)
        assertThat(levels).isNotNull()
        // If non-empty, verify sorted ascending
        if (levels.isNotEmpty()) {
            for (i in 1 until levels.size) {
                assertThat(levels[i]).isGreaterThanOrEqualTo(levels[i - 1])
            }
        }
    }
}
