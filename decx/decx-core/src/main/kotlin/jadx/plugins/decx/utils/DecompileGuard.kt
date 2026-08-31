package jadx.plugins.decx.utils

import jadx.api.JadxArgs
import jadx.api.JadxDecompiler
import jadx.api.JavaClass
import jadx.api.JavaMethod
import java.util.concurrent.LinkedBlockingQueue

/**
 * Single authority for everything derived from the decompiler that must be
 * guarded, bounded, or lazily indexed:
 *
 *  - **decompile guard**: per-class limits (method count / smali size) plus a
 *    free-heap gate, so one pathological class cannot OOM the server;
 *  - **bounded code cache** (headless server): a byte-capped LRU [ICodeCache]
 *    replacing JADX's default unbounded in-memory cache;
 *  - **cold-class unloading**: a bounded, backpressured daemon thread unloads
 *    classes whose code text was evicted, releasing JADX's per-class IR
 *    (method bodies / CFG / attributes / cached smali) that would otherwise
 *    stay resident; the decompile path blocks when the unload queue is full,
 *    so evicted-but-unloaded IR is hard-bounded;
 *  - **symbol inventory**: lazily built class/method name lists for
 *    `get_classes` / `search_method` (metadata only, no decompilation).
 *
 * This was previously spread across DecompileGuard / DecxCodeCacheManager /
 * BoundedCodeCache / SymbolIndex with a redundant compressed source cache on
 * top. The compressed cache is gone (JADX already caches `code` in its code
 * cache and `smali` per class), the unload coordinator and symbol inventory
 * are folded in here, and [BoundedCodeCache] remains as the single code-cache
 * implementation.
 *
 * Lifecycle:
 *  - headless server: [installBoundedCodeCache] on the `JadxArgs` before
 *    constructing the decompiler, then [attach] after construction.
 *  - JADX GUI plugin: no bounded cache needed (the GUI has its own disk-backed
 *    code cache and cleaner); only [reset] is used on unload.
 */
object DecompileGuard {
    // Tunables: -Ddecx.decompile.* for unusually large targets.
    private const val DEFAULT_MAX_SMALI_CHARS = 5_000_000
    private const val DEFAULT_MAX_METHODS = 8_000
    private const val DEFAULT_MIN_FREE_HEAP_BYTES = 512L * 1024L * 1024L
    private const val HARD_CAP_CODE_CACHE_MAX_BYTES = 4L * 1024L * 1024L * 1024L
    private const val DEFAULT_MAX_PENDING_UNLOADS = 4096

    private val maxSmaliChars = intProperty("decx.decompile.maxSmaliChars", DEFAULT_MAX_SMALI_CHARS)
    private val maxMethods = intProperty("decx.decompile.maxMethods", DEFAULT_MAX_METHODS)
    private val minFreeHeapBytes = longProperty("decx.decompile.minFreeHeapBytes", DEFAULT_MIN_FREE_HEAP_BYTES)
    // Explicit -D property wins; otherwise default to min(4G, heap/2) so small
    // -Xmx machines don't get a cache cap they can never actually satisfy.
    private val codeCacheMaxBytes = longProperty("decx.decompile.codeCacheMaxBytes", defaultCodeCacheMaxBytes())
    private val maxPendingUnloads = intProperty("decx.decompile.maxPendingUnloads", DEFAULT_MAX_PENDING_UNLOADS)

    enum class Purpose {
        JAVA,
        SMALI,
        WARMUP,
        XREF
    }

    data class Decision(
        val allowed: Boolean,
        val reason: String = "",
        val smaliChars: Int = 0,
        val methodCount: Int = 0,
        val availableHeapBytes: Long = 0,
        /** Whole-class source when requested through [source]; null otherwise or when denied. */
        val code: String? = null
    ) {
        fun messageFor(className: String): String = "$className: $reason"

        fun meta(): Map<String, Any> = linkedMapOf(
            "reason" to reason,
            "smali_chars" to smaliChars,
            "method_count" to methodCount,
            "available_heap_bytes" to availableHeapBytes,
            "max_smali_chars" to maxSmaliChars,
            "max_methods" to maxMethods,
            "min_free_heap_bytes" to minFreeHeapBytes
        )
    }

    // ==================== bounded code cache + cold-class unloading ====================

    @Volatile
    private var codeCache: BoundedCodeCache? = null

    @Volatile
    private var decompiler: JadxDecompiler? = null

    @Volatile
    private var unloadIndex: Map<String, JavaClass>? = null

    private val pendingUnloads = LinkedBlockingQueue<String>(maxPendingUnloads)

    @Volatile
    private var unloadWorker: Thread? = null

    /**
     * Install the bounded code cache onto [jadxArgs]. Call before constructing
     * the `JadxDecompiler` (headless server only). The GUI plugin skips this:
     * JADX GUI already manages a disk-backed code cache.
     */
    fun installBoundedCodeCache(jadxArgs: JadxArgs) {
        val cache = codeCache ?: BoundedCodeCache(codeCacheMaxBytes) { name -> pendingUnloads.put(name) }.also {
            codeCache = it
            startUnloadWorker()
        }
        jadxArgs.codeCache = cache
    }

    /** Wire the decompiler used to resolve unload targets. Call after construction, before [JadxDecompiler.load]. */
    fun attach(decompiler: JadxDecompiler) {
        this.decompiler = decompiler
        this.unloadIndex = null
    }

    private fun startUnloadWorker() {
        if (unloadWorker != null) return
        unloadWorker = Thread({
            while (true) {
                try {
                    // Block until an evicted class needs unloading. If the
                    // decompile thread fills the bounded queue, its put() blocks
                    // here-until-drained, which is the backpressure that keeps
                    // evicted-but-unloaded IR bounded.
                    unloadIfCold(pendingUnloads.take())
                } catch (_: InterruptedException) {
                    return@Thread
                } catch (e: Exception) {
                    LogUtils.warn("Code cache unload failed: {}", e.message ?: "unknown")
                }
            }
        }, "decx-code-cache-evictor").apply {
            isDaemon = true
            start()
        }
    }

    private fun unloadIfCold(name: String) {
        if (codeCache?.contains(name) == true) return // re-cached since eviction -> still hot
        val clazz = resolveUnloadTarget(name) ?: return
        try {
            clazz.unload()
        } catch (e: Exception) {
            LogUtils.warn("Failed to unload class {}: {}", name, e.message ?: "unknown")
        }
    }

    private fun resolveUnloadTarget(name: String): JavaClass? {
        var index = unloadIndex
        if (index == null) {
            val d = decompiler ?: return null
            // Top-level classes only: inner classes never enter the code cache.
            index = d.classes.associateBy { it.rawName }
            unloadIndex = index
        }
        return index[name]
    }

    // ==================== symbol inventory ====================

    @Volatile
    private var symbolClassNames: List<String>? = null

    @Volatile
    private var symbolMethods: List<JavaMethod>? = null

    @Volatile
    private var symbolBuiltFor: JadxDecompiler? = null

    fun classNames(decompiler: JadxDecompiler): List<String> {
        ensureSymbolsBuilt(decompiler)
        return symbolClassNames!!
    }

    fun methods(decompiler: JadxDecompiler): List<JavaMethod> {
        ensureSymbolsBuilt(decompiler)
        return symbolMethods!!
    }

    private fun ensureSymbolsBuilt(decompiler: JadxDecompiler) {
        if (symbolBuiltFor === decompiler && symbolClassNames != null) return
        synchronized(this) {
            if (symbolBuiltFor === decompiler && symbolClassNames != null) return
            buildSymbols(decompiler)
        }
    }

    private fun buildSymbols(decompiler: JadxDecompiler) {
        val classes = try {
            decompiler.classesWithInners
        } catch (e: Exception) {
            LogUtils.warn("Symbol index build failed to enumerate classes: {}", e.message ?: "unknown")
            emptyList()
        }
        val names = ArrayList<String>(classes.size)
        val mths = ArrayList<JavaMethod>()
        for (clazz in classes) {
            try {
                names.add(clazz.fullName)
            } catch (_: Exception) {
            }
            try {
                for (m in clazz.methods) mths.add(m)
            } catch (_: Exception) {
            }
        }
        symbolClassNames = names
        symbolMethods = mths
        symbolBuiltFor = decompiler
        LogUtils.info("Symbol index built: {} classes, {} methods", names.size, mths.size)
    }

    // ==================== source / decompile / check ====================

    /**
     * Return the whole-class source for [purpose]. Relies on JADX's own caches:
     * `code` is served from the (bounded) code cache, `smali` from the per-class
     * disassembly cache — so repeated reads do not re-decompile unless the class
     * was unloaded for being cold.
     */
    fun source(clazz: JavaClass, purpose: Purpose = Purpose.JAVA): Decision {
        val decision = decompile(clazz, purpose)
        if (!decision.allowed) {
            return decision.copy(code = null)
        }
        val src = when (purpose) {
            Purpose.SMALI -> safeRead { clazz.smali }
            else -> safeRead { clazz.code }
        } ?: return decision.copy(code = null, reason = "source unavailable: ${clazz.fullName}")
        return decision.copy(code = src)
    }

    fun check(clazz: JavaClass, purpose: Purpose = Purpose.JAVA): Decision {
        val methodCount = try {
            clazz.methods.size
        } catch (e: Exception) {
            LogUtils.warn("check failed class={}, error={}", clazz.fullName, e.message ?: "unknown")
            return Decision(
                allowed = false,
                reason = "class introspection failed: ${e.message}",
                availableHeapBytes = availableHeapBytes()
            )
        }
        val availableHeapBytes = availableHeapBytes()

        val baseDecision = when {
            methodCount > maxMethods -> Decision(
                allowed = false,
                reason = "class has too many methods to decompile safely",
                methodCount = methodCount,
                availableHeapBytes = availableHeapBytes
            )
            availableHeapBytes < minFreeHeapBytes -> Decision(
                allowed = false,
                reason = "available heap is below safe decompile threshold",
                methodCount = methodCount,
                availableHeapBytes = availableHeapBytes
            )
            else -> Decision(
                allowed = true,
                methodCount = methodCount,
                availableHeapBytes = availableHeapBytes
            )
        }
        if (!baseDecision.allowed || purpose != Purpose.SMALI) {
            return baseDecision
        }

        val smaliChars = try {
            clazz.smali.length
        } catch (_: Exception) {
            0
        }
        if (smaliChars > maxSmaliChars) {
            return Decision(
                allowed = false,
                reason = "class smali is too large to return safely",
                smaliChars = smaliChars,
                methodCount = methodCount,
                availableHeapBytes = availableHeapBytes
            )
        }
        return baseDecision.copy(smaliChars = smaliChars)
    }

    @Synchronized
    fun decompile(clazz: JavaClass, purpose: Purpose = Purpose.JAVA): Decision {
        val decision = check(clazz, purpose)
        if (decision.allowed) {
            if (purpose == Purpose.SMALI) {
                LogUtils.debug(
                    "Prepared smali class={}, methods={}, smaliChars={}, availableHeapBytes={}",
                    clazz.fullName,
                    decision.methodCount,
                    decision.smaliChars,
                    decision.availableHeapBytes
                )
            } else {
                LogUtils.debug(
                    "Decompiling class={}, purpose={}, methods={}, availableHeapBytes={}",
                    clazz.fullName,
                    purpose,
                    decision.methodCount,
                    decision.availableHeapBytes
                )
                try {
                    clazz.decompile()
                } catch (e: Exception) {
                    LogUtils.warn(
                        "Decompile failed class={}, purpose={}, error={}",
                        clazz.fullName,
                        purpose,
                        e.message ?: "unknown"
                    )
                    return Decision(
                        allowed = false,
                        reason = "decompilation failed: ${e.message}",
                        methodCount = decision.methodCount,
                        availableHeapBytes = decision.availableHeapBytes
                    )
                }
            }
        } else {
            LogUtils.warn(
                "Skipping decompile class={}, purpose={}, reason={}, methods={}, smaliChars={}, availableHeapBytes={}, maxMethods={}, maxSmaliChars={}, minFreeHeapBytes={}",
                clazz.fullName,
                purpose,
                decision.reason,
                decision.methodCount,
                decision.smaliChars,
                decision.availableHeapBytes,
                maxMethods,
                maxSmaliChars,
                minFreeHeapBytes
            )
        }
        return decision
    }

    // ==================== maintenance / stats ====================

    /** Clear the code cache and symbol inventory (keeps the bounded cache installed). */
    fun reset() {
        codeCache?.clear()
        pendingUnloads.clear()
        unloadIndex = null
        synchronized(this) {
            symbolClassNames = null
            symbolMethods = null
            symbolBuiltFor = null
        }
        LogUtils.info("DecompileGuard reset: code cache and symbol index cleared")
    }

    fun stats(): Map<String, Any> = linkedMapOf(
        "kind" to "decompile",
        "min_free_heap_bytes" to minFreeHeapBytes,
        "max_methods" to maxMethods,
        "max_smali_chars" to maxSmaliChars,
        "code_cache" to (codeCache?.stats() ?: emptyMap<String, Any>()),
        "symbols" to linkedMapOf(
            "classes" to (symbolClassNames?.size ?: 0),
            "methods" to (symbolMethods?.size ?: 0)
        ),
        "pending_unloads" to pendingUnloads.size,
        "max_pending_unloads" to maxPendingUnloads
    )

    // ==================== helpers ====================

    private fun availableHeapBytes(): Long {
        val runtime = Runtime.getRuntime()
        return runtime.maxMemory() - runtime.totalMemory() + runtime.freeMemory()
    }

    private fun safeRead(getter: () -> String?): String? = try {
        getter()
    } catch (e: Exception) {
        LogUtils.warn("source read failed: {}", e.message ?: "unknown")
        null
    }

    private fun intProperty(name: String, defaultValue: Int): Int {
        return System.getProperty(name)?.toIntOrNull()?.takeIf { it > 0 } ?: defaultValue
    }

    private fun longProperty(name: String, defaultValue: Long): Long {
        return System.getProperty(name)?.toLongOrNull()?.takeIf { it > 0 } ?: defaultValue
    }

    private fun defaultCodeCacheMaxBytes(): Long {
        val halfHeap = Runtime.getRuntime().maxMemory() / 2
        return minOf(HARD_CAP_CODE_CACHE_MAX_BYTES, halfHeap)
    }
}
