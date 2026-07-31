package jadx.plugins.decx.utils

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class RouteTelemetryTest {

    @BeforeEach
    fun resetState() {
        RouteTelemetry.unbindThread()
        RouteTelemetry.reset()
    }

    @Test
    fun `begin registers an active operation`() {
        val opId = RouteTelemetry.begin("/api/decx/get_classes", total = 10)
        val active = RouteTelemetry.activeSnapshot()
        assertThat(active).hasSize(1)
        assertThat(active[0]["endpoint"]).isEqualTo("/api/decx/get_classes")
        assertThat(active[0]["total"]).isEqualTo(10L)
        // not completed yet -> no stats
        assertThat(RouteTelemetry.statsSnapshot()).isEmpty()
        // cleanup so the op does not leak into other tests via active map
        RouteTelemetry.complete("/api/decx/get_classes", opId, 5, RouteTelemetry.Outcome.SUCCESS)
    }

    @Test
    fun `complete records per-endpoint latency and outcome`() {
        val opId = RouteTelemetry.begin("/x")
        RouteTelemetry.complete("/x", opId, 12, RouteTelemetry.Outcome.SUCCESS)

        val stats = RouteTelemetry.statsSnapshot()
        assertThat(stats).containsKey("/x")
        val s = stats["/x"]!!
        assertThat(s["count"]).isEqualTo(1L)
        assertThat(s["success"]).isEqualTo(1L)
        assertThat(s["error"]).isEqualTo(0L)
        assertThat(s["timeout"]).isEqualTo(0L)
        assertThat(s["avg_ms"]).isEqualTo(12L)
        assertThat(s["max_ms"]).isEqualTo(12L)
    }

    @Test
    fun `multiple samples accumulate and compute p95`() {
        repeat(5) { i ->
            val id = RouteTelemetry.begin("/r")
            RouteTelemetry.complete("/r", id, (i + 1).toLong(), RouteTelemetry.Outcome.SUCCESS)
        }
        val s = RouteTelemetry.statsSnapshot()["/r"]!!
        assertThat(s["count"]).isEqualTo(5L)
        assertThat(s["min_ms"]).isEqualTo(1L)
        assertThat(s["max_ms"]).isEqualTo(5L)
        assertThat(s["avg_ms"]).isEqualTo(3L) // (1+2+3+4+5)/5
        assertThat((s["p95_ms"] as Long)).isBetween(1L, 5L)
    }

    @Test
    fun `timeout and error outcomes are classified`() {
        val t = RouteTelemetry.begin("/t")
        RouteTelemetry.complete("/t", t, 999, RouteTelemetry.Outcome.TIMEOUT)
        val e = RouteTelemetry.begin("/e")
        RouteTelemetry.complete("/e", e, 1, RouteTelemetry.Outcome.ERROR)

        val stats = RouteTelemetry.statsSnapshot()
        assertThat(stats["/t"]!!["timeout"]).isEqualTo(1L)
        assertThat(stats["/e"]!!["error"]).isEqualTo(1L)
    }

    @Test
    fun `thread-bound progress reports scanned and matches`() {
        val opId = RouteTelemetry.begin("/api/decx/search_global_key", total = 0)
        RouteTelemetry.bindThread(opId)
        try {
            RouteTelemetry.currentSetTotal(42)
            RouteTelemetry.currentIncrementScanned()
            RouteTelemetry.currentIncrementScanned()
            RouteTelemetry.currentIncrementMatches()

            val active = RouteTelemetry.activeSnapshot()
            assertThat(active[0]["total"]).isEqualTo(42L)
            assertThat(active[0]["scanned"]).isEqualTo(2L)
            assertThat(active[0]["matches"]).isEqualTo(1L)
        } finally {
            RouteTelemetry.unbindThread()
        }

        // after unbind, progress calls are a no-op (no current op)
        RouteTelemetry.currentIncrementScanned()
        val active = RouteTelemetry.activeSnapshot()
        assertThat(active[0]["scanned"]).isEqualTo(2L)

        RouteTelemetry.complete("/api/decx/search_global_key", opId, 3, RouteTelemetry.Outcome.SUCCESS)
    }

    @Test
    fun `reset clears active ops and stats`() {
        val opId = RouteTelemetry.begin("/z")
        RouteTelemetry.complete("/z", opId, 7, RouteTelemetry.Outcome.SUCCESS)
        assertThat(RouteTelemetry.activeSnapshot()).isEmpty()
        assertThat(RouteTelemetry.statsSnapshot()).isNotEmpty

        RouteTelemetry.reset()
        assertThat(RouteTelemetry.statsSnapshot()).isEmpty()
    }

    @Test
    fun `concurrent begins and completes all counted`() {
        val n = 50
        val threads = (1..n).map { i ->
            Thread {
                val id = RouteTelemetry.begin("/c")
                RouteTelemetry.complete("/c", id, i.toLong(), RouteTelemetry.Outcome.SUCCESS)
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        assertThat(RouteTelemetry.statsSnapshot()["/c"]!!["count"]).isEqualTo(n.toLong())
        assertThat(RouteTelemetry.activeSnapshot()).isEmpty()
    }
}
