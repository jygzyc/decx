package jadx.plugins.decx.utils

import jadx.api.JavaClass
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * Single authority for decompilation: limit checking, triggering [decompile], and
 * caching the decompiled source (compressed) so repeated reads of the same class
 * source never re-decompile.
 *
 * Call [decompile] when you only need the class to be decompiled (xref, method body).
 * Call [source] when you need the whole-class source string ([JavaClass.getCode] /
 * [JavaClass.getSmali]); it goes through the compressed cache.
 */
object DecompileGuard {
    // Tunable with -D decx.decompile.* system properties for unusually large apps.
    private const val DEFAULT_MAX_SMALI_CHARS = 5_000_000
    private const val DEFAULT_MAX_METHODS = 8_000
    private const val DEFAULT_MIN_FREE_HEAP_BYTES = 512L * 1024L * 1024L

    private val maxSmaliChars = intProperty("decx.decompile.maxSmaliChars", DEFAULT_MAX_SMALI_CHARS)
    private val maxMethods = intProperty("decx.decompile.maxMethods", DEFAULT_MAX_METHODS)
    private val minFreeHeapBytes = longProperty("decx.decompile.minFreeHeapBytes", DEFAULT_MIN_FREE_HEAP_BYTES)

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

    // ==================== source cache ====================

    private val sourceCache = ConcurrentHashMap<String, ByteArray>()
    private val hits = AtomicLong(0)
    private val misses = AtomicLong(0)
    private val compressedBytes = AtomicLong(0)
    private val originalBytes = AtomicLong(0)

    private fun cacheKey(clazz: JavaClass, purpose: Purpose) = "${clazz.fullName}::${purpose}"

    /**
     * Return the whole-class source for [purpose], decompiling (and compressed-caching)
     * on cache miss. Uses [decompile] for limit checking / triggering decompilation.
     *
     * Cache hits are lock-free; only the miss path reaches the synchronized [decompile].
     */
    fun source(clazz: JavaClass, purpose: Purpose = Purpose.JAVA): Decision {
        val key = cacheKey(clazz, purpose)
        sourceCache.get(key)?.let { compressed ->
            hits.incrementAndGet()
            val code = decompress(compressed)
            return if (code != null) {
                Decision(allowed = true, code = code)
            } else {
                // Corrupt entry — fall through to re-decompile.
                sourceCache.remove(key)
                source(clazz, purpose)
            }
        }
        misses.incrementAndGet()

        val decision = decompile(clazz, purpose)
        if (!decision.allowed) {
            return decision.copy(code = null)
        }
        val src = when (purpose) {
            Purpose.SMALI -> safeRead { clazz.smali }
            else -> safeRead { clazz.code }
        } ?: return decision.copy(code = null, reason = "source unavailable: ${clazz.fullName}")

        val srcBytes = src.toByteArray(Charsets.UTF_8)
        val compressed = compress(srcBytes)
        if (compressed != null) {
            val previous = sourceCache.put(key, compressed)
            if (previous == null) {
                compressedBytes.addAndGet(compressed.size.toLong())
                originalBytes.addAndGet(srcBytes.size.toLong())
            } else {
                compressedBytes.addAndGet((compressed.size - previous.size).toLong())
            }
        }
        return decision.copy(code = src)
    }

    fun clearCache() {
        val size = sourceCache.size
        val compBytes = compressedBytes.get()
        sourceCache.clear()
        hits.set(0)
        misses.set(0)
        compressedBytes.set(0)
        originalBytes.set(0)
        LogUtils.info("Decompilation source cache cleared: {} entries ({} compressed bytes)", size, compBytes)
    }

    fun stats(): Map<String, Any> {
        val h = hits.get()
        val m = misses.get()
        val total = h + m
        val comp = compressedBytes.get()
        val orig = originalBytes.get()
        return linkedMapOf<String, Any>(
            "kind" to "decompile_source",
            "entries" to sourceCache.size,
            "hits" to h,
            "misses" to m,
            "hit_rate" to (if (total > 0) "%.1f%%".format(h * 100.0 / total) else "N/A"),
            "compressed_bytes" to comp,
            "original_bytes" to orig,
            "compression_ratio" to (if (comp > 0) "%.1fx".format(orig.toDouble() / comp) else "N/A")
        )
    }

    // ==================== limit check + decompile ====================

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

    internal fun compress(data: ByteArray): ByteArray? {
        return try {
            val deflater = Deflater(Deflater.BEST_SPEED)
            deflater.setInput(data)
            deflater.finish()
            val buffer = ByteArray(data.size + 64)
            val compressedSize = deflater.deflate(buffer)
            deflater.end()
            val result = ByteArray(compressedSize)
            System.arraycopy(buffer, 0, result, 0, compressedSize)
            result
        } catch (e: Exception) {
            LogUtils.warn("Failed to compress source: {}", e.message ?: "unknown")
            null
        }
    }

    internal fun decompress(compressed: ByteArray): String? {
        return try {
            val inflater = Inflater()
            inflater.setInput(compressed)
            var buffer = ByteArray((compressed.size.coerceAtLeast(1)) * 20)
            var offset = 0
            while (!inflater.finished()) {
                val count = inflater.inflate(buffer, offset, buffer.size - offset)
                if (count == 0 && !inflater.finished()) {
                    val grown = ByteArray(buffer.size * 2)
                    System.arraycopy(buffer, 0, grown, 0, offset)
                    buffer = grown
                }
                offset += count
            }
            inflater.end()
            String(buffer, 0, offset, Charsets.UTF_8)
        } catch (e: Exception) {
            LogUtils.warn("Failed to decompress source: {}", e.message ?: "unknown")
            null
        }
    }
}
