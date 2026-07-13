package jadx.plugins.decx.utils

import jadx.api.JavaClass

object DecompileGuard {
    // Tunable with -Ddecx.decompile.* system properties for unusually large apps.
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
        val availableHeapBytes: Long = 0
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

    private fun availableHeapBytes(): Long {
        val runtime = Runtime.getRuntime()
        var available = runtime.maxMemory() - runtime.totalMemory() + runtime.freeMemory()
        // If below threshold, try GC once before giving up — disk-backed cache
        // entries and soft-reachable objects may be reclaimed.
        if (available < minFreeHeapBytes) {
            System.gc()
            available = runtime.maxMemory() - runtime.totalMemory() + runtime.freeMemory()
        }
        return available
    }

    private fun intProperty(name: String, defaultValue: Int): Int {
        return System.getProperty(name)?.toIntOrNull()?.takeIf { it > 0 } ?: defaultValue
    }

    private fun longProperty(name: String, defaultValue: Long): Long {
        return System.getProperty(name)?.toLongOrNull()?.takeIf { it > 0 } ?: defaultValue
    }
}
