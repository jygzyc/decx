package jadx.plugins.decx.extension

import jadx.plugins.decx.api.DecxApi
import jadx.plugins.decx.api.DecxRequestParams
import jadx.plugins.decx.taint.TaintExtension
import jadx.plugins.decx.taint.TaintService
import jadx.plugins.decx.taint.TaintEnvironment
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.kotlin.mock
import java.io.File

/**
 * Taint extension tests with a fake environment injected, so route
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
        File(File(taiE, "lib"), "sootclasses-modified.jar").writeText("fake")
        File(File(taiE, "lib"), "flowdroidclasses-modified.jar").writeText("fake")
        File(taiE, "worker").apply { mkdirs() }
        File(File(taiE, "worker"), "decx-taint-worker.jar").writeText("fake")
        File(taiE, "java-benchmarks/JREs/jre1.8").apply { mkdirs() }
        File(File(taiE, "java-benchmarks/JREs/jre1.8"), "rt.jar").writeText("fake")
        return TaintEnvironment(root, useDevFallback = false)
    }

    @Test
    fun `routes are registered for all four taint endpoints`() {
        val ext = TaintExtension(fakeEnv())
        val paths = ext.routeGroups().flatMap { it.routes }.map { it.path }
        assertThat(paths).containsExactlyInAnyOrder(
            "/api/decx/taint/status",
            "/api/decx/taint/analyze",
            "/api/decx/taint/capabilities",
            "/api/decx/taint/templates"
        )
    }

    @Test
    fun `status route returns success envelope with environment info`() {
        val ext = TaintExtension(fakeEnv())
        val api = mock<DecxApi>()
        val status = ext.routeGroups().flatMap { it.routes }.first { it.path == "/api/decx/taint/status" }
        val result = status.invoke(api, DecxRequestParams(emptyMap()))
        assertThat(result.success).isTrue()
        @Suppress("UNCHECKED_CAST")
        val items = result.data["items"] as List<Map<String, Any>>
        assertThat(items).hasSize(1)
        assertThat(items[0]["ready"]).isEqualTo(true)
    }

    @Test
    fun `analyze route rejects invalid config with INVALID_TAINT_CONFIG`() {
        val ext = TaintExtension(fakeEnv())
        val api = mock<DecxApi>()
        val analyze = ext.routeGroups().flatMap { it.routes }.first { it.path == "/api/decx/taint/analyze" }
        val result = analyze.invoke(api, DecxRequestParams(mapOf("config" to "not: [valid yaml")))
        assertThat(result.success).isFalse()
        @Suppress("UNCHECKED_CAST")
        val error = result.data["error"] as Map<String, Any>
        assertThat(error["code"]).isEqualTo(TaintService.CODE_INVALID_CONFIG)
    }

    @Test
    fun `analyze route resolves config then reports engine-not-ready when worker missing`() {
        val env = fakeEnv()
        // break the worker jar so env is ready=false at the service level
        File(env.workerDir, "decx-taint-worker.jar").delete()
        val ext = TaintExtension(env)
        val api = mock<DecxApi>()
        val analyze = ext.routeGroups().flatMap { it.routes }.first { it.path == "/api/decx/taint/analyze" }
        val result = analyze.invoke(
            api,
            DecxRequestParams(
                mapOf(
                    "config" to """
                        preset: privacy-leak
                        target: { session: sieve }
                    """.trimIndent()
                )
            )
        )
        assertThat(result.success).isFalse()
        @Suppress("UNCHECKED_CAST")
        val error = result.data["error"] as Map<String, Any>
        assertThat(error["code"]).isEqualTo(TaintService.CODE_NOT_READY)
    }

    @Test
    fun `mcp tools are exposed for taint surface`() {
        val ext = TaintExtension(fakeEnv())
        val toolNames = ext.mcpTools().map { it.name }
        assertThat(toolNames).contains("taint_analyze", "taint_status", "taint_capabilities", "taint_templates")
    }
}
