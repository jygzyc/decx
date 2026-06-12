package jadx.plugins.decx

import java.io.File

object DecxConstants {
    const val DEFAULT_PORT: Int = 25419
    val SUPPORTED_CACHE_MODES = setOf("memory", "disk")
    const val DEFAULT_CACHE_MODE = "disk"

    fun getVersion(): String {
        try {
            val props = java.util.Properties()
            val input = DecxConstants::class.java.getResourceAsStream("/version.properties")
            if (input != null) {
                props.load(input)
                input.close()
                return props.getProperty("version", "dev")
            }
        } catch (_: Exception) {}
        DecxConstants::class.java.`package`?.implementationVersion
            ?.takeIf { it.isNotBlank() }
            ?.let { return it }
        return readVersionFile() ?: "dev"
    }

    private fun readVersionFile(): String? {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val file = File(dir, "version")
            if (file.isFile) {
                return file.readText().trim().takeIf { it.isNotBlank() }
            }
            dir = dir.parentFile
        }
        return null
    }
}
