package jadx.plugins.decx.utils

import jadx.api.JavaClass
import jadx.api.JadxDecompiler
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

object WarmupUtils {
    private const val DEFAULT_TARGET_COUNT = 15000
    private const val PROGRESS_INTERVAL = 1000
    private const val MAX_THREADS = 4
    private const val DEFAULT_TIMEOUT_SECONDS = 250L

    /**
     * Warmup target count, overridable via -Ddecx.warmup.targetCount.
     * Set to 0 to disable warmup entirely (useful when memory is tight
     * or when TaiEEngine is enabled and competes for heap).
     */
    private val targetCount: Int = System.getProperty("decx.warmup.targetCount")
        ?.toIntOrNull() ?: DEFAULT_TARGET_COUNT

    private val sdkPackagePrefixes = listOf(
        "android.support.",
        "androidx.",
        "java.",
        "javax.",
        "kotlin.",
        "kotlinx."
    )

    fun selectWarmupClasses(
        decompiler: JadxDecompiler,
        targetCount: Int = this.targetCount
    ): List<JavaClass> {
        if (targetCount <= 0) return emptyList() // warmup disabled
        val classes = decompiler.classesWithInners ?: emptyList()
        if (classes.isEmpty()) return emptyList()

        val appClasses = classes.filter { clazz ->
            sdkPackagePrefixes.none { prefix -> clazz.fullName.startsWith(prefix) }
        }

        return if (appClasses.size >= targetCount) {
            appClasses.shuffled().take(targetCount)
        } else {
            appClasses
        }
    }

    fun warmup(
        classes: List<JavaClass>,
        logProgress: (String) -> Unit = LogUtils::info,
        timeoutSeconds: Long = DEFAULT_TIMEOUT_SECONDS
    ): Long {
        if (classes.isEmpty()) return 0L

        val threadCount = min(
            MAX_THREADS,
            Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
        ).coerceAtLeast(1)
        val completed = AtomicInteger(0)
        val skipped = AtomicInteger(0)
        val executor = Executors.newFixedThreadPool(threadCount) { r ->
            Thread(r, "Decx-Warmup-${warmupThreadId.incrementAndGet()}").apply { isDaemon = true }
        }

        val startTime = System.currentTimeMillis()
        try {
            classes.forEach { clazz ->
                executor.execute {
                    try {
                        val decision = DecompileGuard.decompile(clazz, DecompileGuard.Purpose.WARMUP)
                        if (!decision.allowed) {
                            skipped.incrementAndGet()
                        }
                    } catch (_: Exception) {
                    } finally {
                        val count = completed.incrementAndGet()
                        if (count % PROGRESS_INTERVAL == 0 || count == classes.size) {
                            logProgress("Warmup progress: $count/${classes.size}, skipped=${skipped.get()}")
                        }
                    }
                }
            }
        } finally {
            executor.shutdown()
            if (!executor.awaitTermination(timeoutSeconds, TimeUnit.SECONDS)) {
                executor.shutdownNow()
                logProgress("Warmup timed out after ${timeoutSeconds}s: ${completed.get()}/${classes.size}, skipped=${skipped.get()}")
            }
        }

        return System.currentTimeMillis() - startTime
    }

    private val warmupThreadId = AtomicInteger(0)
}
