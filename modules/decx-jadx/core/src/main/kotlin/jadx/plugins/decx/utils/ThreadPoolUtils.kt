package jadx.plugins.decx.utils

import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicInteger

object ThreadPoolUtils {
    /**
     * Create a fixed-size daemon thread pool with a counter-based naming prefix.
     *
     * @param prefix  thread name prefix (e.g. "DecxServer-Route")
     * @param maxThreads  cap on pool size; bounded to [2, maxThreads]
     */
    fun createNamedDaemonPool(prefix: String, maxThreads: Int): java.util.concurrent.ExecutorService {
        val size = maxOf(2, minOf(maxThreads, Runtime.getRuntime().availableProcessors()))
        return Executors.newFixedThreadPool(size, object : ThreadFactory {
            private val counter = AtomicInteger(0)
            override fun newThread(r: Runnable): Thread {
                return Thread(r, "$prefix-${counter.incrementAndGet()}").apply {
                    isDaemon = true
                }
            }
        })
    }
}
