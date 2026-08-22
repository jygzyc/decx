package jadx.plugins.decx.taint.protocol

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.io.BufferedReader
import java.io.StringReader
import java.io.StringWriter

class WorkerProtocolTest {

    @Test
    fun `ready message round-trips`() {
        val original = WorkerMessage.ready(1234)
        val decoded = WorkerProtocol.decode(WorkerProtocol.encode(original))
        assertThat(decoded.type).isEqualTo(WorkerMessage.TYPE_READY)
        assertThat(decoded.pid).isEqualTo(1234)
    }

    @Test
    fun `analyze message round-trips all config fragments`() {
        val original = WorkerMessage.analyze(
            id = 42,
            apk = "E:/apps/sieve.apk",
            platforms = "D:/sdk/platforms",
            analysis = mapOf("algorithm" to "pta", "contextSensitivity" to "2obj"),
            limits = mapOf("timeoutSec" to 600),
            taint = mapOf(
                "sources" to listOf(mapOf("kind" to "call", "method" to "<A: java.lang.String a()>", "index" to "result")),
                "sinks" to listOf(mapOf("method" to "<B: void b(java.lang.String)>", "index" to "0"))
            ),
            raw = mapOf("pta" to mapOf("cs" to "2obj+H"))
        )
        val decoded = WorkerProtocol.decode(WorkerProtocol.encode(original))
        assertThat(decoded.type).isEqualTo(WorkerMessage.TYPE_ANALYZE)
        assertThat(decoded.id).isEqualTo(42)
        assertThat(decoded.apk).isEqualTo("E:/apps/sieve.apk")
        assertThat(decoded.platforms).isEqualTo("D:/sdk/platforms")
        assertThat(decoded.analysisConfig).containsEntry("contextSensitivity", "2obj")
        @Suppress("UNCHECKED_CAST")
        val sources = decoded.taintConfig?.get("sources") as List<Map<String, Any>>
        assertThat(sources).hasSize(1)
        assertThat(sources[0]["method"]).isEqualTo("<A: java.lang.String a()>")
        assertThat(decoded.rawConfig).isNotNull()
    }

    @Test
    fun `result message round-trips flows`() {
        val flow = TaintFlowDto(
            source = "<App: void main()>[0@L3] %v3 = invokestatic SourceSink.source()/result",
            sink = "<App: void main()>[2@L5] invokestatic SourceSink.sink(%v4)/0",
            sourceMethod = "<App: void main()>",
            sinkMethod = "<App: void main()>",
            sourceLine = 3,
            sinkLine = 5
        )
        val original = WorkerMessage.result(7, listOf(flow), mapOf("durationMs" to 1000, "flowCount" to 1))
        val decoded = WorkerProtocol.decode(WorkerProtocol.encode(original))
        assertThat(decoded.type).isEqualTo(WorkerMessage.TYPE_RESULT)
        assertThat(decoded.flows).hasSize(1)
        assertThat(decoded.flows[0].sourceMethod).isEqualTo("<App: void main()>")
        assertThat(decoded.flows[0].sinkLine).isEqualTo(5)
        assertThat((decoded.meta["flowCount"] as Number).toInt()).isEqualTo(1)
    }

    @Test
    fun `error message round-trips`() {
        val original = WorkerMessage.error(3, "analysis_failed", "boom")
        val decoded = WorkerProtocol.decode(WorkerProtocol.encode(original))
        assertThat(decoded.type).isEqualTo(WorkerMessage.TYPE_ERROR)
        assertThat(decoded.code).isEqualTo("analysis_failed")
        assertThat(decoded.message).isEqualTo("boom")
    }

    @Test
    fun `malformed line throws protocol exception`() {
        assertThatThrownBy { WorkerProtocol.decode("{not json") }
            .isInstanceOf(WorkerProtocol.ProtocolException::class.java)
    }

    @Test
    fun `write and read over a reader writer pair`() {
        val writer = StringWriter()
        WorkerProtocol.write(writer, WorkerMessage.ready(99))
        WorkerProtocol.write(writer, WorkerMessage.shutdown())

        val reader = BufferedReader(StringReader(writer.toString()))
        val first = WorkerProtocol.read(reader)
        val second = WorkerProtocol.read(reader)
        val eof = WorkerProtocol.read(reader)

        assertThat(first?.type).isEqualTo(WorkerMessage.TYPE_READY)
        assertThat(first?.pid).isEqualTo(99)
        assertThat(second?.type).isEqualTo(WorkerMessage.TYPE_SHUTDOWN)
        assertThat(eof).isNull()
    }
}
