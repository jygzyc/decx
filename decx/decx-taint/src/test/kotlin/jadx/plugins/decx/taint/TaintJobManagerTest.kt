package jadx.plugins.decx.taint

import jadx.plugins.decx.taint.config.TaintConfig
import jadx.plugins.decx.taint.config.TargetConfig
import jadx.plugins.decx.taint.protocol.TaintFlowDto
import jadx.plugins.decx.taint.rules.RuleEntry
import jadx.plugins.decx.taint.rules.TaintRule
import jadx.plugins.decx.taint.rules.TaintRuleCompiler
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.mockito.kotlin.any
import org.mockito.kotlin.argumentCaptor
import org.mockito.kotlin.mock
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever
import java.util.concurrent.TimeUnit

class TaintJobManagerTest {

    private val pool: TaintWorkerPool = mock()
    private val manager = TaintJobManager(pool, queueCapacity = 2, historyLimit = 4)

    @AfterEach
    fun tearDown() {
        manager.close()
    }

    private val compiled: TaintRuleCompiler.CompiledRules = TaintRuleCompiler.compile(
        listOf(
            TaintRule(
                name = "r1",
                sources = listOf(RuleEntry("<a.Src: java.lang.String src()>", "result")),
                sinks = listOf(RuleEntry("<a.Sink: void sink(java.lang.String)>", "0"))
            )
        )
    )

    private fun request(): AnalyzeRequest = AnalyzeRequest(
        id = 1L,
        apk = "/tmp/app.apk",
        platforms = null,
        config = TaintConfig(target = TargetConfig(apk = "/tmp/app.apk")),
        taintFragment = compiled.taintFragment
    )

    private fun awaitTerminal(jobId: String): Map<String, Any> {
        var deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            val snapshot = manager.detail(jobId)?.snapshot
            if (snapshot != null && snapshot["state"] in TaintJobManager.STATE_TERMINAL) return snapshot
            Thread.sleep(20)
        }
        throw AssertionError("job did not reach a terminal state in time")
    }

    @Test
    fun `successful job captures progress and flows`() {
        val progressCaptor = argumentCaptor<(String, String) -> Unit>()
        whenever(pool.analyze(any(), progressCaptor.capture())).thenAnswer { invocation ->
            val onProgress = invocation.getArgument<(String, String) -> Unit>(1)
            onProgress("building", "world built")
            onProgress("analyzing", "pta finished")
            TaintWorkerPool.Outcome(
                flows = listOf(
                    TaintFlowDto(
                        source = "<a.A: void m()>[0@L1] <a.Src: java.lang.String src()>",
                        sink = "<a.B: void n()>[0@L2] <a.Sink: void sink(java.lang.String)>",
                        sourceMethod = "<a.Src: java.lang.String src()>",
                        sinkMethod = "<a.Sink: void sink(java.lang.String)>"
                    )
                ),
                meta = mapOf("durationMs" to 42L, "flowCount" to 1)
            )
        }

        val jobId = manager.submit(request(), compiled)
        val snapshot = awaitTerminal(jobId)

        assertThat(snapshot["state"]).isEqualTo(TaintJobManager.STATE_SUCCEEDED)
        assertThat(snapshot["progressLog"]).asString().contains("world built")
        val detail = manager.detail(jobId)!!
        assertThat(detail.flows).hasSize(1)
        assertThat(detail.compiled).isNotNull
        // worker received the compiled taint fragment
        val requestCaptor = argumentCaptor<AnalyzeRequest>()
        verify(pool).analyze(requestCaptor.capture(), any())
        @Suppress("UNCHECKED_CAST")
        val taint = requestCaptor.firstValue.taintFragment as Map<String, Any>
        assertThat(taint["callSiteMode"]).isEqualTo(true)
    }

    @Test
    fun `failing analysis marks the job failed`() {
        whenever(pool.analyze(any(), any())).thenThrow(TaintException("boom"))

        val jobId = manager.submit(request(), compiled)
        val snapshot = awaitTerminal(jobId)

        assertThat(snapshot["state"]).isEqualTo(TaintJobManager.STATE_FAILED)
        @Suppress("UNCHECKED_CAST")
        val error = snapshot["error"] as Map<String, Any>
        assertThat(error["code"]).isEqualTo(TaintService.CODE_ANALYSIS_FAILED)
        assertThat(error["message"]).isEqualTo("boom")
    }

    @Test
    fun `cancelling a queued job skips execution`() {
        // Block the single worker thread so submitted jobs stay queued
        val release = java.util.concurrent.CountDownLatch(1)
        whenever(pool.analyze(any(), any())).thenAnswer { release.await(10, TimeUnit.SECONDS); TaintWorkerPool.Outcome(emptyList(), emptyMap()) }
        val blocker = manager.submit(request(), compiled)

        val queued = manager.submit(request(), compiled)
        assertThat(manager.detail(queued)!!.snapshot["state"]).isEqualTo(TaintJobManager.STATE_QUEUED)

        val cancelled = manager.cancel(queued)
        assertThat(cancelled).isTrue()
        release.countDown()
        awaitTerminal(blocker)
        awaitTerminal(queued)
        assertThat(manager.detail(queued)!!.snapshot["state"]).isEqualTo(TaintJobManager.STATE_CANCELLED)
    }

    @Test
    fun `queue capacity is enforced`() {
        val release = java.util.concurrent.CountDownLatch(1)
        whenever(pool.analyze(any(), any())).thenAnswer { release.await(10, TimeUnit.SECONDS); TaintWorkerPool.Outcome(emptyList(), emptyMap()) }
        val blocker = manager.submit(request(), compiled)
        manager.submit(request(), compiled) // queue slot 1
        manager.submit(request(), compiled) // queue slot 2

        assertThatThrownBy { manager.submit(request(), compiled) }
            .isInstanceOf(TaintException::class.java)
            .hasMessageContaining("queue is full")

        release.countDown()
        awaitTerminal(blocker)
    }

    @Test
    fun `list returns recent jobs without flows`() {
        whenever(pool.analyze(any(), any())).thenReturn(TaintWorkerPool.Outcome(emptyList(), emptyMap()))
        val jobId = manager.submit(request(), compiled)
        awaitTerminal(jobId)
        val list = manager.list()
        assertThat(list).hasSize(1)
        assertThat(list[0]["jobId"]).isEqualTo(jobId)
        assertThat(list[0]).doesNotContainKey("flows")
    }

    @Test
    fun `unknown job details are null`() {
        assertThat(manager.detail("nope")).isNull()
        assertThat(manager.cancel("nope")).isFalse()
    }
}
