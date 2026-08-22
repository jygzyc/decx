package jadx.plugins.decx.taint

import jadx.plugins.decx.api.DecxApi
import jadx.plugins.decx.api.DecxRequestParams
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.kotlin.mock
import java.io.File

/**
 * Taint extension route tests with a fake environment injected, so route
 * registration and execution can be verified without a real worker install.
 */
class TaintExtensionTest {

    /** Fake env: a temp dir laid out like DECX_HOME/tai-e + fake jars. */
    private fun fakeEnv(): TaintEnvironment {
        val root = File(System.getProperty("java.io.tmpdir"), "decx-taint-test-${System.nanoTime()}").apply {
            mkdirs()
        }
        val taiE = File(root, "tai-e").apply { mkdirs() }
        File(taiE, "lib").apply { mkdirs() }
        File(File(taiE, "lib"), "tai-e-0.5.4.jar").writeText("fake")
        File(File(taiE, "lib"), "sootclasses-modified.jar").writeText("fake")
        File(taiE, "worker").apply { mkdirs() }
        File(File(taiE, "worker"), "decx-taint-worker.jar").writeText("fake")
        File(taiE, "java-benchmarks/JREs/jre1.8").apply { mkdirs() }
        File(File(taiE, "java-benchmarks/JREs/jre1.8"), "rt.jar").writeText("fake")
        return TaintEnvironment(root, useDevFallback = false)
    }

    private fun TaintExtension.route(path: String) =
        routeGroups().flatMap { it.routes }.first { it.path == path }

    @Test
    fun `routes are registered for the three taint interfaces`() {
        val ext = TaintExtension(fakeEnv())
        val paths = ext.routeGroups().flatMap { it.routes }.map { it.path }
        assertThat(paths).containsExactlyInAnyOrder(
            "/api/decx/taint/config",
            "/api/decx/taint/analyze",
            "/api/decx/taint/progress"
        )
    }

    @Test
    fun `mcp tools mirror the three taint interfaces`() {
        val ext = TaintExtension(fakeEnv())
        val toolNames = ext.mcpTools().map { it.name }
        assertThat(toolNames).containsExactlyInAnyOrder("taint_config", "taint_analyze", "taint_progress")
    }

    @Test
    fun `config route without input returns engine, environment and built-in rules`() {
        val ext = TaintExtension(fakeEnv())
        val api = mock<DecxApi>()
        val result = ext.route("/api/decx/taint/config").invoke(api, DecxRequestParams(emptyMap()))
        assertThat(result.success).isTrue()
        @Suppress("UNCHECKED_CAST")
        val items = result.data["items"] as List<Map<String, Any>>
        val kinds = items.map { it["kind"] }
        assertThat(kinds).contains("taint_engine", "taint_environment", "taint_rule")
        val ruleItems = items.filter { it["kind"] == "taint_rule" }
        assertThat(ruleItems.map { it["id"] }).contains("deviceIdLeak", "locationLeak", "userInputLeak")
    }

    @Test
    fun `config route with inline rules validates and returns summaries`() {
        val ext = TaintExtension(fakeEnv())
        val api = mock<DecxApi>()
        val result = ext.route("/api/decx/taint/config").invoke(
            api,
            DecxRequestParams(
                mapOf(
                    "rules" to """
                        {
                          "customLeak": {
                            "severity": "low",
                            "sources": [{ "method": "<a.b.C: java.lang.String src()>", "index": "result" }],
                            "sinks": [{ "method": "<a.b.D: void sink(java.lang.String)>", "index": 0 }]
                          }
                        }
                    """.trimIndent()
                )
            )
        )
        assertThat(result.success).isTrue()
        @Suppress("UNCHECKED_CAST")
        val items = result.data["items"] as List<Map<String, Any>>
        val rule = items.first { it["id"] == "customLeak" }
        @Suppress("UNCHECKED_CAST")
        val meta = rule["meta"] as Map<String, Any>
        assertThat(meta["severity"]).isEqualTo("low")
        assertThat(meta["sourceCount"]).isEqualTo(1)
        assertThat(meta["sinkCount"]).isEqualTo(1)
    }

    @Test
    fun `config route rejects invalid rule json with INVALID_TAINT_CONFIG`() {
        val ext = TaintExtension(fakeEnv())
        val api = mock<DecxApi>()
        val result = ext.route("/api/decx/taint/config").invoke(
            api,
            DecxRequestParams(mapOf("rules" to "{ not valid json"))
        )
        assertThat(result.success).isFalse()
        @Suppress("UNCHECKED_CAST")
        val error = result.data["error"] as Map<String, Any>
        assertThat(error["code"]).isEqualTo(TaintService.CODE_INVALID_CONFIG)
    }

    @Test
    fun `analyze route reports engine-not-ready when worker missing`() {
        val env = fakeEnv()
        // break the worker jar so env is ready=false at the service level
        File(env.workerDir, "decx-taint-worker.jar").delete()
        val ext = TaintExtension(env)
        val api = mock<DecxApi>()
        val result = ext.route("/api/decx/taint/analyze").invoke(
            api,
            DecxRequestParams(
                mapOf(
                    "target" to mapOf("session" to "sieve")
                )
            )
        )
        assertThat(result.success).isFalse()
        @Suppress("UNCHECKED_CAST")
        val error = result.data["error"] as Map<String, Any>
        assertThat(error["code"]).isEqualTo(TaintService.CODE_NOT_READY)
    }

    @Test
    fun `progress route reports unknown job`() {
        val ext = TaintExtension(fakeEnv())
        val api = mock<DecxApi>()
        val result = ext.route("/api/decx/taint/progress").invoke(
            api,
            DecxRequestParams(mapOf("jobId" to "taint-does-not-exist"))
        )
        assertThat(result.success).isFalse()
        @Suppress("UNCHECKED_CAST")
        val error = result.data["error"] as Map<String, Any>
        assertThat(error["code"]).isEqualTo(TaintService.CODE_JOB_NOT_FOUND)
    }

    @Test
    fun `progress route without jobId lists recent jobs`() {
        val ext = TaintExtension(fakeEnv())
        val api = mock<DecxApi>()
        val result = ext.route("/api/decx/taint/progress").invoke(api, DecxRequestParams(emptyMap()))
        assertThat(result.success).isTrue()
        @Suppress("UNCHECKED_CAST")
        val items = result.data["items"] as List<Map<String, Any>>
        assertThat(items).isEmpty()
    }
}
