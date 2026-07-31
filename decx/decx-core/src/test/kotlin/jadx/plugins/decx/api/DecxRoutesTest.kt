package jadx.plugins.decx.api

import jadx.plugins.decx.utils.AnalysisResultUtils
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Verifies the unified [DecxApiResult] envelope and that every API method still
 * resolves through the route registry after the DecxApiImpl refactor (removal of
 * the response-cache wrapper).
 */
class DecxApiResultTest {

    @Test
    fun `ok and fail flags`() {
        assertThat(DecxApiResult.ok(emptyMap()).success).isTrue()
        assertThat(DecxApiResult.fail(emptyMap()).success).isFalse()
    }

    @Test
    fun `success builder carries ok kind and items`() {
        val items = listOf(AnalysisResultUtils.item("a", "symbol", "A", "aa"))
        val r = DecxApiResult.success("classes", mapOf("k" to 1), items)
        assertThat(r.success).isTrue()
        assertThat(r.data["ok"]).isEqualTo(true)
        assertThat(r.data["kind"]).isEqualTo("classes")
        assertThat(r.data["items"]).isEqualTo(items)
    }

    @Test
    fun `error builder carries ok=false and error block`() {
        val r = DecxApiResult.error("classes", emptyMap(), code = "BAD", message = "nope")
        assertThat(r.success).isFalse()
        assertThat(r.data["ok"]).isEqualTo(false)
        val err = r.data["error"] as Map<*, *>
        assertThat(err["code"]).isEqualTo("BAD")
        assertThat(err["message"]).isEqualTo("nope")
    }
}

class DecxRoutesTest {

    @Test
    fun `all routes have unique paths`() {
        val paths = DecxRoutes.all.map { it.path }
        assertThat(paths.size).isEqualTo(paths.toSet().size)
    }

    @Test
    fun `routeOf resolves known paths and rejects unknown`() {
        assertThat(DecxRoutes.routeOf("/api/decx/get_classes")).isNotNull
        assertThat(DecxRoutes.routeOf("/api/decx/search_method")).isNotNull
        assertThat(DecxRoutes.routeOf("/api/decx/does_not_exist")).isNull()
    }

    @Test
    fun `kindOf maps known paths and falls back to unknown`() {
        assertThat(DecxRoutes.kindOf("/api/decx/get_classes")).isEqualTo(DecxKind.CLASSES)
        assertThat(DecxRoutes.kindOf("/api/decx/search_global_key")).isEqualTo(DecxKind.SEARCH_GLOBAL)
        assertThat(DecxRoutes.kindOf("/api/decx/search_method")).isEqualTo(DecxKind.SEARCH_METHOD)
        assertThat(DecxRoutes.kindOf("/api/decx/get_method_source")).isEqualTo(DecxKind.METHOD_SOURCE)
        assertThat(DecxRoutes.kindOf("/api/decx/get_class_xref")).isEqualTo(DecxKind.CLASS_XREF)
        assertThat(DecxRoutes.kindOf("/nope")).isEqualTo("unknown")
    }

    @Test
    fun `expected route set is intact`() {
        val paths = DecxRoutes.all.map { it.path }.toSet()
        assertThat(paths).contains(
            "/api/decx/get_classes",
            "/api/decx/search_global_key",
            "/api/decx/search_class_key",
            "/api/decx/search_method",
            "/api/decx/get_method_source",
            "/api/decx/get_class_source",
            "/api/decx/get_class_context",
            "/api/decx/get_method_context",
            "/api/decx/get_method_cfg",
            "/api/decx/get_method_xref",
            "/api/decx/get_field_xref",
            "/api/decx/get_class_xref",
            "/api/decx/get_implement",
            "/api/decx/get_sub_classes",
            "/api/decx/get_aidl",
            "/api/decx/get_app_manifest",
            "/api/decx/get_main_activity",
            "/api/decx/get_application",
            "/api/decx/get_exported_components",
            "/api/decx/get_deep_links",
            "/api/decx/get_dynamic_receivers",
            "/api/decx/get_all_resources",
            "/api/decx/get_resource_file",
            "/api/decx/get_strings",
            "/api/decx/get_system_service_impl",
            "/api/decx/get_selected_text",
            "/api/decx/get_selected_class"
        )
    }
}
