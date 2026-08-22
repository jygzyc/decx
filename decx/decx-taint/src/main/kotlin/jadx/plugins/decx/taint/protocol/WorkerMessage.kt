package jadx.plugins.decx.taint.protocol

/**
 * One taint flow as reported by the worker. Human-readable strings mirror the
 * Tai-e TaintFlow toString, plus structured fields for machine consumption.
 */
data class TaintFlowDto(
    /** Human-readable source description, e.g. `<App: void main()>[0@L3] ...`. */
    val source: String,
    /** Human-readable sink description. */
    val sink: String,
    /** Source method signature, e.g. `<App: void main(java.lang.String[])>`. */
    val sourceMethod: String,
    /** Sink method signature. */
    val sinkMethod: String,
    /** 1-based source line in the source method (when known). */
    val sourceLine: Int? = null,
    /** 1-based sink line in the sink method (when known). */
    val sinkLine: Int? = null
)

/**
 * Single wire message shared by the orchestrator (decx-core) and the worker.
 *
 * One class covers all message kinds; `type` discriminates. Unused fields are
 * null/empty for a given kind. Serialized as one JSON object per line (NDJSON).
 *
 * Orchestrator -> worker:
 *   {"type":"analyze",  "id":1, "apk":..., "platforms":..., "analysisConfig":{...},
 *                      "limitsConfig":{...}, "taintConfig":{...}, "rawConfig":{...}}
 *   {"type":"shutdown"}
 *
 * Worker -> orchestrator:
 *   {"type":"ready",    "pid":1234}
 *   {"type":"progress", "id":1, "stage":"building", "message":"..."}
 *   {"type":"result",   "id":1, "ok":true, "flows":[...], "meta":{...}}
 *   {"type":"error",    "id":1, "code":"...", "message":"..."}
 *   {"type":"bye"}
 */
data class WorkerMessage(
    val type: String,
    val id: Long = 0,
    val pid: Long = 0,
    val apk: String? = null,
    val platforms: String? = null,
    val analysisConfig: Map<String, Any>? = null,
    val limitsConfig: Map<String, Any>? = null,
    val taintConfig: Map<String, Any>? = null,
    val rawConfig: Map<String, Any>? = null,
    val stage: String? = null,
    val message: String? = null,
    val code: String? = null,
    val ok: Boolean = false,
    val flows: List<TaintFlowDto> = emptyList(),
    val meta: Map<String, Any> = emptyMap()
) {
    companion object {
        const val TYPE_READY = "ready"
        const val TYPE_ANALYZE = "analyze"
        const val TYPE_PROGRESS = "progress"
        const val TYPE_RESULT = "result"
        const val TYPE_ERROR = "error"
        const val TYPE_SHUTDOWN = "shutdown"
        const val TYPE_BYE = "bye"

        fun ready(pid: Long) = WorkerMessage(TYPE_READY, pid = pid)
        fun analyze(
            id: Long,
            apk: String,
            platforms: String?,
            analysis: Map<String, Any>,
            limits: Map<String, Any>,
            taint: Map<String, Any>,
            raw: Map<String, Any>?
        ) = WorkerMessage(
            type = TYPE_ANALYZE,
            id = id,
            apk = apk,
            platforms = platforms,
            analysisConfig = analysis,
            limitsConfig = limits,
            taintConfig = taint,
            rawConfig = raw
        )
        fun progress(id: Long, stage: String, message: String) =
            WorkerMessage(TYPE_PROGRESS, id = id, stage = stage, message = message)
        fun result(id: Long, flows: List<TaintFlowDto>, meta: Map<String, Any>) =
            WorkerMessage(TYPE_RESULT, id = id, ok = true, flows = flows, meta = meta)
        fun error(id: Long, code: String, message: String) =
            WorkerMessage(TYPE_ERROR, id = id, code = code, message = message)
        fun shutdown() = WorkerMessage(TYPE_SHUTDOWN)
        fun bye(pid: Long = 0) = WorkerMessage(TYPE_BYE, pid = pid)
    }
}
