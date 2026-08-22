package jadx.plugins.decx.taint

import jadx.plugins.decx.taint.config.TaintConfig
import jadx.plugins.decx.taint.protocol.TaintFlowDto
import jadx.plugins.decx.taint.rules.TaintRuleCompiler
import jadx.plugins.decx.utils.LogUtils
import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * Async taint-analysis job manager.
 *
 * Jobs move through: QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED.
 * Execution is serialized on one daemon thread (one Tai-e worker JVM at a
 * time — the Tai-e world is process-scoped); pending jobs wait in a bounded
 * queue. Progress messages are kept in a per-job ring buffer (latest 100).
 *
 * Progress polling never blocks: `taint/progress` reads job state as it is.
 */
class TaintJobManager(
    private val pool: TaintWorkerPool,
    private val queueCapacity: Int = DEFAULT_QUEUE_CAPACITY,
    private val historyLimit: Int = DEFAULT_HISTORY_LIMIT
) : Closeable {

    companion object {
        const val STATE_QUEUED = "queued"
        const val STATE_RUNNING = "running"
        const val STATE_SUCCEEDED = "succeeded"
        const val STATE_FAILED = "failed"
        const val STATE_CANCELLED = "cancelled"
        val STATE_TERMINAL = setOf(STATE_SUCCEEDED, STATE_FAILED, STATE_CANCELLED)

        const val DEFAULT_QUEUE_CAPACITY = 8
        const val DEFAULT_HISTORY_LIMIT = 32
        const val PROGRESS_LOG_LIMIT = 100
    }

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "DecxTaint-Job").apply { isDaemon = true }
    }
    private val jobs = LinkedHashMap<String, Job>() // guarded by lock
    private val lock = Object()
    private val seq = AtomicLong(0)
    @Volatile private var closed = false

    init {
        // Best-effort cleanup of a possibly in-flight worker JVM.
        Runtime.getRuntime().addShutdownHook(Thread { close() })
    }

    private class Job(
        val id: String,
        val request: AnalyzeRequest,
        val ruleNames: List<String>,
        val compiled: TaintRuleCompiler.CompiledRules
    ) {
        val createdAtMs: Long = System.currentTimeMillis()
        var startedAtMs: Long? = null
        var endedAtMs: Long? = null
        var state: String = STATE_QUEUED
        var stage: String = "queued"
        var message: String = "waiting for worker"
        val progressLog = ArrayList<Map<String, Any>>()
        var flows: List<TaintFlowDto> = emptyList()
        var meta: Map<String, Any> = emptyMap()
        var errorCode: String? = null
        var errorMessage: String? = null
        @Volatile var cancelRequested = false
    }

    /** Typed job view consumed by the service layer for envelope building. */
    data class JobDetail(
        /** Snapshot without flows/summary. */
        val snapshot: Map<String, Any>,
        /** Raw worker flows (empty unless the job succeeded). */
        val flows: List<TaintFlowDto>,
        /** Compiled rules the job ran with (for flow attribution). */
        val compiled: TaintRuleCompiler.CompiledRules?
    )

    /** Enqueue an analysis; returns the job id. */
    @Throws(TaintException::class)
    fun submit(request: AnalyzeRequest, compiled: TaintRuleCompiler.CompiledRules): String {
        check(!closed) { "TaintJobManager is closed" }
        val jobId = "taint-${System.currentTimeMillis()}-${seq.incrementAndGet()}"
        val job = Job(jobId, request, compiled.rules.map { it.name }, compiled)
        val rejected = synchronized(lock) {
            val active = jobs.values.count { it.state !in STATE_TERMINAL }
            if (active >= queueCapacity + 1) { // 1 running + queueCapacity waiting
                true
            } else {
                jobs[jobId] = job
                false
            }
        }
        if (rejected) {
            val message = "Taint job queue is full ($queueCapacity waiting). Retry when running jobs finish."
            LogUtils.warn("[taint] $message")
            throw TaintException(message)
        }
        executor.submit { runJob(job) }
        return jobId
    }

    /** @return false when the job is unknown or already finished. */
    fun cancel(jobId: String): Boolean {
        val job = synchronized(lock) { jobs[jobId] } ?: return false
        val wasRunning = synchronized(job) {
            if (job.state in STATE_TERMINAL) return false
            job.cancelRequested = true
            job.state == STATE_RUNNING
        }
        if (wasRunning) {
            // Only a RUNNING job owns the in-flight worker JVM (execution is
            // serialized); destroying it makes pool.analyze fail fast.
            pool.destroyCurrent()
        }
        return true
    }

    /** Full job detail including raw flows + compiled rules when succeeded. */
    fun detail(jobId: String): JobDetail? {
        val job = synchronized(lock) { jobs[jobId] } ?: return null
        return synchronized(job) {
            JobDetail(
                snapshot = job.toMap(),
                flows = job.flows,
                compiled = job.compiled
            )
        }
    }

    /** Recent jobs (active first, newest first), without flows. */
    fun list(): List<Map<String, Any>> {
        val snapshots = synchronized(lock) { jobs.values.toList() }
        return snapshots
            .sortedWith(compareBy({ it.state in STATE_TERMINAL }, { it.createdAtMs }))
            .reversed()
            .map { job -> synchronized(job) { job.toMap() } }
    }

    override fun close() {
        if (closed) return
        closed = true
        pool.destroyCurrent()
        executor.shutdownNow()
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private fun runJob(job: Job) {
        if (job.cancelRequested) {
            finish(job, STATE_CANCELLED, errorCode = TaintException.CODE_CANCELLED, errorMessage = "cancelled before start")
            return
        }
        synchronized(job) {
            job.state = STATE_RUNNING
            job.startedAtMs = System.currentTimeMillis()
            job.stage = "starting"
            job.message = "analysis started"
        }
        try {
            val outcome = pool.analyze(job.request) { stage, message ->
                synchronized(job) {
                    job.stage = stage
                    job.message = message
                    appendProgress(job, stage, message)
                }
            }
            synchronized(job) {
                job.flows = outcome.flows
                job.meta = outcome.meta
            }
            finish(job, STATE_SUCCEEDED)
        } catch (e: TaintException) {
            if (job.cancelRequested) {
                finish(job, STATE_CANCELLED, errorCode = TaintException.CODE_CANCELLED, errorMessage = "cancelled by user")
            } else {
                finish(job, STATE_FAILED, errorCode = TaintService.CODE_ANALYSIS_FAILED, errorMessage = e.message)
            }
        } catch (e: Exception) {
            LogUtils.error(jadx.plugins.decx.api.DecxError.SERVER_INTERNAL_ERROR, e, "[taint] unexpected job failure")
            finish(job, STATE_FAILED, errorCode = TaintService.CODE_ANALYSIS_FAILED, errorMessage = "Unexpected failure: ${e.message}")
        }
    }

    private fun finish(job: Job, state: String, errorCode: String? = null, errorMessage: String? = null) {
        synchronized(job) {
            job.state = state
            job.endedAtMs = System.currentTimeMillis()
            job.stage = state
            job.message = errorMessage ?: state
            job.errorCode = errorCode
            job.errorMessage = errorMessage
        }
        trimHistory()
    }

    private fun appendProgress(job: Job, stage: String, message: String) {
        job.progressLog.add(
            linkedMapOf(
                "timestampMs" to System.currentTimeMillis(),
                "stage" to stage,
                "message" to message
            )
        )
        while (job.progressLog.size > PROGRESS_LOG_LIMIT) {
            job.progressLog.removeAt(0)
        }
    }

    private fun trimHistory() {
        synchronized(lock) {
            val terminal = jobs.entries.filter { it.value.state in STATE_TERMINAL }
            val excess = terminal.size - historyLimit
            if (excess > 0) {
                terminal.take(excess).forEach { jobs.remove(it.key) }
            }
        }
    }

    private fun Job.toMap(): Map<String, Any> {
        val map = linkedMapOf<String, Any>(
            "jobId" to id,
            "state" to state,
            "stage" to stage,
            "message" to message,
            "createdAtMs" to createdAtMs,
            "startedAtMs" to (startedAtMs ?: 0L),
            "endedAtMs" to (endedAtMs ?: 0L),
            "elapsedMs" to ((endedAtMs ?: System.currentTimeMillis()) - createdAtMs),
            "apk" to request.apk,
            "ruleNames" to ruleNames,
            "analysis" to linkedMapOf(
                "contextSensitivity" to request.config.analysis.contextSensitivity,
                "scope" to request.config.analysis.scope
            ),
            "limits" to linkedMapOf(
                "timeoutSec" to request.config.limits.timeoutSec,
                "maxPointerAnalyzeTimeSec" to request.config.limits.maxPointerAnalyzeTimeSec
            ),
            "progressLog" to progressLog.toList()
        )
        if (state == STATE_FAILED || state == STATE_CANCELLED) {
            map["error"] = linkedMapOf(
                "code" to (errorCode ?: TaintService.CODE_ANALYSIS_FAILED),
                "message" to (errorMessage ?: state)
            )
        }
        return map
    }
}
