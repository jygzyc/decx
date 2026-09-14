package jadx.plugins.decx.utils

import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Route-level telemetry: in-flight operations (per progress) + per-endpoint latency
 * stats. Instrumented from [jadx.plugins.decx.server.DecxServer.handleRoute], surfaced
 * via `/health`, and echoed to logs (per-request + periodic aggregate).
 *
 * Progress (scanned/total/matches) is reported by long searches through the
 * request-scoped thread binding; it is best-effort and no-op outside a bound route.
 */
object RouteTelemetry {

    enum class Outcome { SUCCESS, ERROR, TIMEOUT }

    private const val DEFAULT_SLOW_MS = 5_000L
    private const val DEFAULT_LOG_INTERVAL_SEC = 60L
    private const val STALE_MS = 15L * 60L * 1000L
    private const val RECENT_CAP = 128

    private val slowMs = longProperty("decx.telemetry.slowMs", DEFAULT_SLOW_MS)
    private val logIntervalSec = longProperty("decx.telemetry.logIntervalSec", DEFAULT_LOG_INTERVAL_SEC)

    // ==================== in-flight ops ====================

    private class Op(
        val id: Long,
        val endpoint: String,
        val startMs: Long,
        val scanned: AtomicLong = AtomicLong(0),
        val total: AtomicLong = AtomicLong(0),
        val matches: AtomicLong = AtomicLong(0)
    )

    private val active = ConcurrentHashMap<Long, Op>()
    private val currentOpId = ThreadLocal<Long?>()
    private val opSeq = AtomicLong(0)

    /** Register a new in-flight route. Returns its id. */
    fun begin(endpoint: String, total: Long = 0): Long {
        val id = opSeq.incrementAndGet()
        active[id] = Op(id, endpoint, System.currentTimeMillis(), total = AtomicLong(total))
        return id
    }

    /** Bind [opId] to the current thread so services can report progress. */
    fun bindThread(opId: Long) {
        currentOpId.set(opId)
    }

    /** Clear the thread binding (must run in a finally on the route thread). */
    fun unbindThread() {
        currentOpId.remove()
    }

    fun currentSetTotal(total: Long) {
        currentOpId.get()?.let { active[it]?.total?.set(total) }
    }

    fun currentIncrementScanned() {
        currentOpId.get()?.let { active[it]?.scanned?.incrementAndGet() }
    }

    fun currentIncrementMatches() {
        currentOpId.get()?.let { active[it]?.matches?.incrementAndGet() }
    }

    /** Finalize the op, record per-endpoint latency, and log the request line. */
    fun complete(endpoint: String, opId: Long, elapsedMs: Long, outcome: Outcome) {
        active.remove(opId)
        val stat = stats.computeIfAbsent(endpoint) { EndpointStat() }
        stat.record(elapsedMs, outcome)
        if (outcome == Outcome.TIMEOUT || elapsedMs > slowMs) {
            LogUtils.warn("route {} {}ms ({}) — slow", endpoint, elapsedMs, outcome.name.lowercase())
        } else {
            LogUtils.debug("route {} {}ms ({})", endpoint, elapsedMs, outcome.name.lowercase())
        }
    }

    // ==================== snapshots ====================

    fun activeSnapshot(): List<Map<String, Any>> {
        val now = System.currentTimeMillis()
        return active.values.map { op ->
            val elapsed = now - op.startMs
            linkedMapOf<String, Any>(
                "endpoint" to op.endpoint,
                "elapsed_ms" to elapsed,
                "scanned" to op.scanned.get(),
                "total" to op.total.get(),
                "matches" to op.matches.get(),
                "stale" to (elapsed > STALE_MS)
            )
        }
    }

    fun statsSnapshot(): Map<String, Map<String, Any>> {
        return stats.mapValues { it.value.snapshot() }
    }

    /** Clear in-flight ops, per-endpoint stats, and counters (reload). */
    fun reset() {
        active.clear()
        stats.clear()
    }

    // ==================== periodic aggregate logger ====================

    @Volatile
    private var scheduler: ScheduledExecutorService? = null

    fun startLogger() {
        if (logIntervalSec <= 0) return
        if (scheduler != null) return
        synchronized(this) {
            if (scheduler != null) return
            scheduler = Executors.newSingleThreadScheduledExecutor { r ->
                Thread(r, "Decx-Telemetry-Logger").apply { isDaemon = true }
            }
            scheduler?.scheduleAtFixedRate({ logAggregate() }, logIntervalSec, logIntervalSec, TimeUnit.SECONDS)
            LogUtils.info("Route telemetry logger started (interval={}s)", logIntervalSec)
        }
    }

    fun stopLogger() {
        scheduler?.let {
            it.shutdownNow()
            scheduler = null
        }
    }

    private fun logAggregate() {
        val snap = statsSnapshot()
        if (snap.isEmpty()) return
        LogUtils.info("endpoint stats: {}", snap.toString())
    }

    // ==================== per-endpoint stat ====================

    private class EndpointStat {
        val count = AtomicLong(0)
        val success = AtomicLong(0)
        val error = AtomicLong(0)
        val timeout = AtomicLong(0)
        val sumMs = AtomicLong(0)
        val minMs = AtomicLong(Long.MAX_VALUE)
        val maxMs = AtomicLong(0)
        private val recent = ArrayDeque<Long>()

        fun record(ms: Long, outcome: Outcome) {
            count.incrementAndGet()
            sumMs.addAndGet(ms)
            updateMin(minMs, ms)
            updateMax(maxMs, ms)
            when (outcome) {
                Outcome.SUCCESS -> success.incrementAndGet()
                Outcome.ERROR -> error.incrementAndGet()
                Outcome.TIMEOUT -> timeout.incrementAndGet()
            }
            synchronized(recent) {
                recent.addLast(ms)
                while (recent.size > RECENT_CAP) recent.removeFirst()
            }
        }

        fun snapshot(): Map<String, Any> {
            val c = count.get()
            val sorted = synchronized(recent) { recent.sorted() }
            val p95 = if (sorted.isEmpty()) 0L else sorted[((sorted.size - 1) * 0.95).toInt()]
            return linkedMapOf<String, Any>(
                "count" to c,
                "success" to success.get(),
                "error" to error.get(),
                "timeout" to timeout.get(),
                "avg_ms" to if (c > 0) sumMs.get() / c else 0L,
                "min_ms" to if (c > 0) minMs.get() else 0L,
                "max_ms" to maxMs.get(),
                "p95_ms" to p95
            )
        }

        private fun updateMin(ref: AtomicLong, v: Long) {
            var cur = ref.get()
            while (v < cur && !ref.compareAndSet(cur, v)) cur = ref.get()
        }

        private fun updateMax(ref: AtomicLong, v: Long) {
            var cur = ref.get()
            while (v > cur && !ref.compareAndSet(cur, v)) cur = ref.get()
        }
    }

    private val stats = ConcurrentHashMap<String, EndpointStat>()

    private fun longProperty(name: String, defaultValue: Long): Long {
        return System.getProperty(name)?.toLongOrNull()?.takeIf { it > 0 } ?: defaultValue
    }
}
