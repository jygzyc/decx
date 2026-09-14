package jadx.plugins.decx.utils

import com.google.gson.GsonBuilder
import jadx.api.JadxDecompiler
import jadx.api.impl.InMemoryCodeCache
import jadx.plugins.decx.DecxConstants
import jadx.plugins.decx.api.DecxError
import java.io.File
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

object PreferencesManager {

    private const val CONFIG_DIR_NAME = ".decx"
    private const val CONFIG_FILE_NAME = "config.json"
    private const val LEGACY_MCP_CONFIG_FILE_NAME = "mcp.json"

    private val configLock = ReentrantReadWriteLock()

    private val configDir: File = File(System.getProperty("user.home"), CONFIG_DIR_NAME)
    private val configFile: File = File(configDir, CONFIG_FILE_NAME)
    private val gson = GsonBuilder().setPrettyPrinting().create()

    private data class DecxConfig(
        var port: Int = DecxConstants.DEFAULT_PORT,
        var cache: String = DecxConstants.DEFAULT_CACHE_MODE,
        var mcpAutoStart: Boolean = false
    )

    private data class LegacyMcpConfig(
        var autoStart: Boolean = false
    )

    @Volatile
    private var config: DecxConfig = DecxConfig()

    @Volatile
    private var configInitialized = false

    // ========== Initialization ==========

    /**
     * Initialize with a JADX decompiler (plugin mode).
     * Sets up code cache based on config.
     */
    fun initialize(decompiler: JadxDecompiler) {
        ensureConfigLoaded()
        setupCodeCache(decompiler)
    }

    private fun setupCodeCache(decompiler: JadxDecompiler) {
        val cache = configLock.read { config.cache }
        val cacheDir = getCacheDir()

        try {
            when (cache) {
                "memory" -> {
                    decompiler.args.setCodeCache(InMemoryCodeCache())
                }
                "disk" -> {
                    try {
                        val diskCacheClass = Class.forName("jadx.gui.cache.code.disk.DiskCodeCache")
                        val codeStringCacheClass = Class.forName("jadx.gui.cache.code.CodeStringCache")
                        val diskCache = diskCacheClass.getConstructor(java.nio.file.Path::class.java)
                            .newInstance(cacheDir.toPath())
                        val codeStringCache = codeStringCacheClass.getConstructor(diskCacheClass)
                            .newInstance(diskCache)
                        @Suppress("UNCHECKED_CAST")
                        decompiler.args.setCodeCache(codeStringCache as jadx.api.ICodeCache)
                    } catch (_: ClassNotFoundException) {
                        LogUtils.debug("Disk code cache not available (jadx-gui not loaded), using memory cache")
                        decompiler.args.setCodeCache(InMemoryCodeCache())
                    }
                }
            }
        } catch (e: Exception) {
            LogUtils.debug("Failed to setup code cache: ${e.message}")
        }
    }

    // ========== Port ==========

    fun setPort(port: Int) {
        configLock.write { config.port = port }
        saveConfig()
    }

    fun getPort(): Int = configLock.read { config.port }

    // ========== MCP ==========

    fun setMcpAutoStart(enabled: Boolean) {
        configLock.write { config.mcpAutoStart = enabled }
        saveConfig()
    }

    fun getMcpAutoStart(): Boolean = configLock.read { config.mcpAutoStart }

    // ========== Cache ==========

    private fun getCacheDir(): File {
        return File(System.getProperty("user.home"), ".decx/cache/").apply { mkdirs() }
    }

    fun clearCache() {
        val cacheDir = getCacheDir()
        if (cacheDir.exists()) {
            cacheDir.deleteRecursively()
            LogUtils.info("Code cache cleared: $cacheDir")
        }
    }

    // ========== Config File ==========

    private fun ensureConfigLoaded() {
        if (!configInitialized) {
            configLock.write {
                if (!configInitialized) {
                    loadConfig()
                    configInitialized = true
                }
            }
        }
    }

    private fun loadConfig() {
        try {
            if (!configDir.exists()) configDir.mkdirs()

            if (configFile.exists()) {
                val json = configFile.readText()
                config = gson.fromJson(json, DecxConfig::class.java) ?: DecxConfig()
                migrateLegacyMcpConfigIfNeeded()
                LogUtils.debug("Loaded config from $configFile")
            } else {
                config = DecxConfig()
                migrateLegacyMcpConfigIfNeeded()
                saveConfig()
                LogUtils.debug("Created default config at $configFile")
            }
        } catch (e: Exception) {
            LogUtils.error(DecxError.SERVICE_ERROR, "Failed to load config: ${e.message}")
            config = DecxConfig()
        }
    }

    private fun migrateLegacyMcpConfigIfNeeded() {
        val legacyFile = File(configDir, LEGACY_MCP_CONFIG_FILE_NAME)
        if (!legacyFile.exists() || config.mcpAutoStart) return

        try {
            val legacy = gson.fromJson(legacyFile.readText(), LegacyMcpConfig::class.java)
            config.mcpAutoStart = legacy?.autoStart == true
        } catch (e: Exception) {
            LogUtils.debug("Failed to migrate legacy MCP config: ${e.message}")
        }
    }

    private fun saveConfig() {
        try {
            if (!configDir.exists()) configDir.mkdirs()
            configFile.writeText(gson.toJson(config))
            LogUtils.debug("Saved config to $configFile")
        } catch (e: Exception) {
            LogUtils.error(DecxError.SERVICE_ERROR, "Failed to save config: ${e.message}")
        }
    }
}
