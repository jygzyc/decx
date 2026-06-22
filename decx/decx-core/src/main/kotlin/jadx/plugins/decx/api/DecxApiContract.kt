package jadx.plugins.decx.api

object DecxKind {
    const val CLASSES = "classes"
    const val SEARCH_GLOBAL = "search_global"
    const val CLASS_CONTEXT = "class_context"
    const val CLASS_SOURCE = "class_source"
    const val SEARCH_CLASS = "search_class"
    const val SEARCH_METHOD = "search_method"
    const val METHOD_CONTEXT = "method_context"
    const val METHOD_SOURCE = "method_source"
    const val METHOD_CFG = "method_cfg"
    const val METHOD_XREF = "method_xref"
    const val FIELD_XREF = "field_xref"
    const val CLASS_XREF = "class_xref"
    const val IMPLEMENTATIONS = "implementations"
    const val SUB_CLASSES = "sub_classes"
    const val APP_MANIFEST = "app_manifest"
    const val MAIN_ACTIVITY = "main_activity"
    const val APPLICATION = "application"
    const val EXPORTED_COMPONENTS = "exported_components"
    const val DEEP_LINKS = "deep_links"
    const val DYNAMIC_RECEIVERS = "dynamic_receivers"
    const val ALL_RESOURCES = "all_resources"
    const val RESOURCE_FILE = "resource_file"
    const val STRINGS = "strings"
    const val AIDL_INTERFACES = "aidl_interfaces"
    const val SYSTEM_SERVICE_IMPL = "system_service_impl"
    const val SELECTED_CLASS = "selected_class"
    const val SELECTED_TEXT = "selected_text"
}

data class DecxRoute(
    val path: String,
    val kind: String,
    val invoke: (DecxApi, DecxRequestParams) -> DecxApiResult
)

/**
 * A route group is the canonical format for adding a DECX service surface.
 *
 * To add a service:
 * 1. Add service methods to DecxApi and DecxApiImpl.
 * 2. Add a DecxRouteGroup here with all HTTP paths for that service.
 * 3. Register the group in DecxRoutes.groups.
 * 4. Add matching MCP tools in McpToolRegistry when the service should be MCP-visible.
 */
data class DecxRouteGroup(
    val name: String,
    val routes: List<DecxRoute>
)

object DecxRoutes {
    val common = DecxRouteGroup(
        name = "common",
        routes = listOf(
            DecxRoute("/api/decx/get_classes", DecxKind.CLASSES) { api, params -> api.getClasses(params.filter()) },
            DecxRoute("/api/decx/search_global_key", DecxKind.SEARCH_GLOBAL) { api, params ->
                api.searchGlobalKey(params.string("key"), params.search())
            },
            DecxRoute("/api/decx/search_class_key", DecxKind.SEARCH_CLASS) { api, params ->
                api.searchClassKey(params.string("cls"), params.string("key"), params.grep())
            },
            DecxRoute("/api/decx/search_method", DecxKind.SEARCH_METHOD) { api, params -> api.searchMethod(params.string("mth")) },
            DecxRoute("/api/decx/get_method_source", DecxKind.METHOD_SOURCE) { api, params ->
                api.getMethodSource(params.string("mth"), params.boolean("smali"))
            }
        )
    )

    val context = DecxRouteGroup(
        name = "context",
        routes = listOf(
            DecxRoute("/api/decx/get_class_context", DecxKind.CLASS_CONTEXT) { api, params -> api.getClassContext(params.string("cls")) },
            DecxRoute("/api/decx/get_class_source", DecxKind.CLASS_SOURCE) { api, params ->
                api.getClassSource(params.string("cls"), params.boolean("smali"), params.filter())
            },
            DecxRoute("/api/decx/get_method_context", DecxKind.METHOD_CONTEXT) { api, params -> api.getMethodContext(params.string("mth")) },
            DecxRoute("/api/decx/get_method_cfg", DecxKind.METHOD_CFG) { api, params -> api.getMethodCfg(params.string("mth")) },
            DecxRoute("/api/decx/get_method_xref", DecxKind.METHOD_XREF) { api, params -> api.getMethodXref(params.string("mth")) },
            DecxRoute("/api/decx/get_field_xref", DecxKind.FIELD_XREF) { api, params -> api.getFieldXref(params.string("fld")) },
            DecxRoute("/api/decx/get_class_xref", DecxKind.CLASS_XREF) { api, params -> api.getClassXref(params.string("cls")) },
            DecxRoute("/api/decx/get_implement", DecxKind.IMPLEMENTATIONS) { api, params -> api.getImplementOfInterface(params.string("iface")) },
            DecxRoute("/api/decx/get_sub_classes", DecxKind.SUB_CLASSES) { api, params -> api.getSubclasses(params.string("cls")) }
        )
    )

    val android = DecxRouteGroup(
        name = "android",
        routes = listOf(
            DecxRoute("/api/decx/get_aidl", DecxKind.AIDL_INTERFACES) { api, params -> api.getAidlInterfaces(params.filter()) },
            DecxRoute("/api/decx/get_app_manifest", DecxKind.APP_MANIFEST) { api, _ -> api.getAppManifest() },
            DecxRoute("/api/decx/get_main_activity", DecxKind.MAIN_ACTIVITY) { api, _ -> api.getMainActivity() },
            DecxRoute("/api/decx/get_application", DecxKind.APPLICATION) { api, _ -> api.getApplication() },
            DecxRoute("/api/decx/get_exported_components", DecxKind.EXPORTED_COMPONENTS) { api, params -> api.getExportedComponents(params.exported()) },
            DecxRoute("/api/decx/get_deep_links", DecxKind.DEEP_LINKS) { api, _ -> api.getDeepLinks() },
            DecxRoute("/api/decx/get_dynamic_receivers", DecxKind.DYNAMIC_RECEIVERS) { api, params -> api.getDynamicReceivers(params.filter()) },
            DecxRoute("/api/decx/get_all_resources", DecxKind.ALL_RESOURCES) { api, params -> api.getAllResources(params.filter()) },
            DecxRoute("/api/decx/get_resource_file", DecxKind.RESOURCE_FILE) { api, params -> api.getResourceFile(params.string("res")) },
            DecxRoute("/api/decx/get_strings", DecxKind.STRINGS) { api, _ -> api.getStrings() },
            DecxRoute("/api/decx/get_system_service_impl", DecxKind.SYSTEM_SERVICE_IMPL) { api, params ->
                api.getSystemServiceImpl(params.string("iface"))
            }
        )
    )

    val ui = DecxRouteGroup(
        name = "ui",
        routes = listOf(
            DecxRoute("/api/decx/get_selected_text", DecxKind.SELECTED_TEXT) { api, _ -> api.getSelectedText() },
            DecxRoute("/api/decx/get_selected_class", DecxKind.SELECTED_CLASS) { api, _ -> api.getSelectedClass() }
        )
    )

    val groups: List<DecxRouteGroup> = listOf(common, context, android, ui)
    val all: List<DecxRoute> = groups.flatMap { it.routes }

    private val routesByPath = all.associateBy { it.path }
    private val kindByPath = all.associate { it.path to it.kind }

    fun kindOf(path: String): String = kindByPath[path] ?: "unknown"
    fun routeOf(path: String): DecxRoute? = routesByPath[path]
}
