package jadx.plugins.decx.server

import jadx.plugins.decx.extension.DecxExtensions

data class McpTool(
    val name: String,
    val description: String,
    val inputSchema: Map<String, Any>,
    val routePath: String,
    val toPayload: (Map<String, Any>) -> Map<String, Any>
)

/**
 * MCP tools are a transport-facing view over DecxRoutes.
 *
 * Keep the mapping here thin: validate/normalize MCP arguments, build the
 * existing core route payload, and let RouteHandler/DecxApi own the business
 * logic. Tool names and argument names should stay DECX-native and match the
 * schema below; avoid compatibility aliases unless there is a real public
 * migration need.
 */
object McpToolRegistry {

    // ---------------------------------------------------------------------
    // Shared schema property descriptors — declared first so tool groups
    // below can reference them during object initialization.
    // ---------------------------------------------------------------------

    private val pageProp = prop("integer", "1-based page number applied to the final DECX response items; defaults to 1.")
    private val limitProp = prop("integer", "Maximum items, matches, or source lines to return. 0 or negative means unlimited; otherwise clamped to at most 10000.")
    private val classNameProp = prop("string", "Exact full class name as returned by get_classes, e.g. com.example.MainActivity.")
    private val interfaceNameProp = prop("string", "Exact full interface class name as returned by get_classes or get_aidl_interfaces.")
    private val includePackagesProp = arrayProp("Include only class names, interface names, component tag names, or resource paths matching these filters. Interpreted as regex by default.")
    private val excludePackagesProp = arrayProp("Exclude class names, interface names, component tag names, or resource paths matching these filters. Interpreted as regex by default.")
    private val regexProp = prop("boolean", "Interpret key/include/exclude filters as regular expressions. Defaults to true; set false for literal substring matching where supported.")

    val tools: List<McpTool> = listOf(healthTool()) + commonTools() + contextTools() + androidTools() + uiTools() + DecxExtensions.mcpTools

    private val toolsByName: Map<String, McpTool> = tools.associateBy { it.name }
    private val toolsByRoute: Map<String, List<McpTool>> = tools.groupBy { it.routePath }

    fun toolOf(name: String): McpTool? = toolsByName[name]

    fun toolsForRoute(routePath: String): List<McpTool> = toolsByRoute[routePath].orEmpty()

    // ---------------------------------------------------------------------
    // Tool groups — keep these aligned with DecxRoutes groups.
    // ---------------------------------------------------------------------

    private fun commonTools(): List<McpTool> = listOf(
        routeTool(
            name = "get_classes",
            description = "Return class symbols from the current JADX project. Each item contains the full class name; include/exclude filters match class names.",
            routePath = "/api/decx/get_classes",
            properties = filterProperties(),
            toPayload = { args -> linkedMapOf("filter" to filterPayload(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "search_global_key",
            description = "Search class names and Java decompiled class bodies for a keyword/regex. Returns matching class symbols, not individual matching lines.",
            routePath = "/api/decx/search_global_key",
            properties = filterProperties() + mapOf("key" to prop("string", "Keyword or regex to search globally.")),
            required = listOf("key"),
            toPayload = { args -> linkedMapOf("key" to stringArg(args, "key"), "search" to filterPayload(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "search_class_key",
            description = "Search Java method bodies inside one class. Returns matching source lines with method signature and line metadata.",
            routePath = "/api/decx/search_class_key",
            properties = mapOf(
                "class_name" to classNameProp,
                "key" to prop("string", "Keyword or regex to search in the class."),
                "limit" to limitProp,
                "regex" to regexProp,
                "page" to pageProp
            ),
            required = listOf("class_name", "key"),
            toPayload = { args ->
                linkedMapOf(
                    "cls" to classArg(args),
                    "key" to stringArg(args, "key"),
                    "grep" to grepPayload(args),
                    "page" to pageArg(args)
                )
            }
        ),
        routeTool(
            name = "search_method",
            description = "Find methods whose full method signature contains the given substring, case-insensitive. Returns exact method signature symbols for use with get_method_* tools.",
            routePath = "/api/decx/search_method",
            properties = mapOf(
                "method_name" to prop("string", "Case-insensitive substring to search within full DECX method signatures."),
                "page" to pageProp
            ),
            required = listOf("method_name"),
            toPayload = { args -> linkedMapOf("mth" to methodArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_method_source",
            description = "Return Java method body or extracted Smali body for one method. Requires an exact method signature returned by search_method or get_class_context.",
            routePath = "/api/decx/get_method_source",
            properties = methodProperties() + mapOf("smali" to prop("boolean", "Return Smali instead of Java source.")),
            required = listOf("method_name"),
            toPayload = { args -> linkedMapOf("mth" to methodArg(args), "smali" to boolArg(args, "smali", false), "page" to pageArg(args)) }
        )
    )

    private fun contextTools(): List<McpTool> = listOf(
        routeTool(
            name = "get_class_context",
            description = "Return one class symbol plus all exact method and field signatures declared in that class.",
            routePath = "/api/decx/get_class_context",
            properties = classProperties(),
            required = listOf("class_name"),
            toPayload = { args -> linkedMapOf("cls" to classArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_class_source",
            description = "Return Java or Smali source for an exact full class name. Optional limit returns only the first N source lines.",
            routePath = "/api/decx/get_class_source",
            properties = classProperties() + mapOf("limit" to limitProp, "smali" to prop("boolean", "Return Smali instead of Java source.")),
            required = listOf("class_name"),
            toPayload = { args -> classSourcePayload(args, smaliDefault = false) }
        ),
        routeTool(
            name = "get_smali_of_class",
            description = "Return Smali source for an exact full class name. Optional limit returns only the first N source lines.",
            routePath = "/api/decx/get_class_source",
            properties = classProperties() + mapOf("limit" to limitProp),
            required = listOf("class_name"),
            toPayload = { args -> classSourcePayload(args, smaliDefault = true) }
        ),
        routeTool(
            name = "get_method_context",
            description = "Return metadata, caller xrefs, and callee invoke summaries for one method. Requires an exact method signature returned by search_method or get_class_context.",
            routePath = "/api/decx/get_method_context",
            properties = methodProperties(),
            required = listOf("method_name"),
            toPayload = { args -> linkedMapOf("mth" to methodArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_method_cfg",
            description = "Return the method control-flow graph as Graphviz DOT generated from JADX basic blocks. Requires an exact method signature returned by search_method or get_class_context.",
            routePath = "/api/decx/get_method_cfg",
            properties = methodProperties(),
            required = listOf("method_name"),
            toPayload = { args -> linkedMapOf("mth" to methodArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_method_xref",
            description = "Return call sites that reference the target method. Requires an exact method signature returned by search_method or get_class_context; each xref includes caller/member, owner class, source line, and line number metadata.",
            routePath = "/api/decx/get_method_xref",
            properties = methodProperties(),
            required = listOf("method_name"),
            toPayload = { args -> linkedMapOf("mth" to methodArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_field_xref",
            description = "Return usage sites that reference the target field. Requires an exact field signature returned by get_class_context; each xref includes owner class, member, source line, and line number metadata.",
            routePath = "/api/decx/get_field_xref",
            properties = fieldProperties(),
            required = listOf("field_name"),
            toPayload = { args -> linkedMapOf("fld" to fieldArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_class_xref",
            description = "Return usage sites that reference the target class symbol, excluding import-only lines.",
            routePath = "/api/decx/get_class_xref",
            properties = classProperties(),
            required = listOf("class_name"),
            toPayload = { args -> linkedMapOf("cls" to classArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_implementations",
            description = "Find classes whose Smali directly declares the target interface in a .implement directive.",
            routePath = "/api/decx/get_implementations",
            properties = mapOf("interface_name" to interfaceNameProp, "page" to pageProp),
            required = listOf("interface_name"),
            toPayload = { args -> linkedMapOf("iface" to interfaceArg(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_subclasses",
            description = "Find classes whose Smali directly declares the target class in a .super directive.",
            routePath = "/api/decx/get_subclasses",
            properties = classProperties(),
            required = listOf("class_name"),
            toPayload = { args -> linkedMapOf("cls" to classArg(args), "page" to pageArg(args)) }
        )
    )

    private fun androidTools(): List<McpTool> = listOf(
        routeTool(
            name = "get_aidl_interfaces",
            description = "Discover AIDL-style interfaces by finding *.Stub classes and concrete subclasses of those stubs. Returns interface, stub, and implementation class names.",
            routePath = "/api/decx/get_aidl_interfaces",
            properties = filterProperties(),
            toPayload = { args -> linkedMapOf("filter" to filterPayload(args), "page" to pageArg(args)) }
        ),
        noArgRoute("get_app_manifest", "Return AndroidManifest.xml content as XML code.", "/api/decx/get_app_manifest"),
        noArgRoute("get_main_activity", "Resolve the launcher activity declared in AndroidManifest.xml and return its full class name.", "/api/decx/get_main_activity"),
        noArgRoute("get_application", "Resolve the custom Application class declared in AndroidManifest.xml and return its full class name.", "/api/decx/get_application"),
        routeTool(
            name = "get_exported_components",
            description = "Parse AndroidManifest.xml and list exported activities, services, receivers, and providers with permissions, intent filters, authorities, and activity/provider attributes.",
            routePath = "/api/decx/get_exported_components",
            properties = filterProperties(),
            toPayload = { args -> filterPayload(args) + mapOf("page" to pageArg(args)) }
        ),
        noArgRoute("get_deep_links", "Parse manifest intent-filters with VIEW+BROWSABLE+DEFAULT and return normalized URI parts plus owning component.", "/api/decx/get_deep_links"),
        routeTool(
            name = "get_dynamic_receivers",
            description = "Find methods whose decompiled Java body calls registerReceiver. Returns full method code and class/method metadata.",
            routePath = "/api/decx/get_dynamic_receivers",
            properties = filterProperties(),
            toPayload = { args -> linkedMapOf("filter" to filterPayload(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_all_resources",
            description = "List resource file paths, including subfiles expanded from resources.arsc when available. Filters match resource paths.",
            routePath = "/api/decx/get_all_resources",
            properties = filterProperties(),
            toPayload = { args -> linkedMapOf("filter" to filterPayload(args), "page" to pageArg(args)) }
        ),
        routeTool(
            name = "get_resource_file",
            description = "Return text content for one resource path, either a direct resource file or a subfile inside resources.arsc.",
            routePath = "/api/decx/get_resource_file",
            properties = mapOf("resource_name" to prop("string", "Exact resource path from get_all_resources, e.g. res/values/strings.xml."), "page" to pageProp),
            required = listOf("resource_name"),
            toPayload = { args -> linkedMapOf("res" to resourceArg(args), "page" to pageArg(args)) }
        ),
        noArgRoute("get_strings", "Parse res/values/strings.xml from direct resources or resources.arsc and return individual string name/value entries.", "/api/decx/get_strings"),
        routeTool(
            name = "get_system_service_impl",
            description = "Find the concrete Binder service class whose Smali extends the target interface's Stub class; returns implementation plus its methods and fields.",
            routePath = "/api/decx/get_system_service_impl",
            properties = mapOf("interface_name" to interfaceNameProp, "page" to pageProp),
            required = listOf("interface_name"),
            toPayload = { args -> linkedMapOf("iface" to interfaceArg(args), "page" to pageArg(args)) }
        )
    )

    private fun uiTools(): List<McpTool> = listOf(
        noArgRoute("get_selected_text", "Plugin GUI mode only: return the currently selected text from the active JADX editor tab.", "/api/decx/get_selected_text"),
        noArgRoute("get_selected_class", "Plugin GUI mode only: return the active JADX tab title and selected text from that tab.", "/api/decx/get_selected_class")
    )

    // ---------------------------------------------------------------------
    // Schema helpers.
    // ---------------------------------------------------------------------

    private fun schema(
        properties: Map<String, Map<String, Any>> = emptyMap(),
        required: List<String> = emptyList()
    ): Map<String, Any> = linkedMapOf(
        "type" to "object",
        "properties" to properties,
        "required" to required
    )

    private fun prop(type: String, description: String): Map<String, Any> = linkedMapOf(
        "type" to type,
        "description" to description
    )

    private fun arrayProp(description: String): Map<String, Any> = linkedMapOf(
        "type" to "array",
        "items" to mapOf("type" to "string"),
        "description" to description
    )

    private fun classProperties() = linkedMapOf("class_name" to classNameProp, "page" to pageProp)
    private fun methodProperties() = linkedMapOf(
        "method_name" to prop("string", "Exact full DECX method signature as returned by search_method or get_class_context. This is matched exactly after whitespace removal."),
        "page" to pageProp
    )
    private fun fieldProperties() = linkedMapOf(
        "field_name" to prop("string", "Exact full DECX field signature as returned by get_class_context. This is matched exactly after whitespace removal."),
        "page" to pageProp
    )
    private fun filterProperties() = linkedMapOf(
        "limit" to limitProp,
        "include_packages" to includePackagesProp,
        "exclude_packages" to excludePackagesProp,
        "regex" to regexProp,
        "page" to pageProp
    )

    private fun healthTool() = McpTool(
        name = "health_check",
        description = "Check MCP and DECX server status.",
        inputSchema = schema(),
        routePath = "__health__",
        toPayload = { emptyMap() }
    )

    private fun noArgRoute(name: String, description: String, routePath: String) =
        routeTool(name, description, routePath, properties = mapOf("page" to pageProp)) { args -> linkedMapOf("page" to pageArg(args)) }

    private fun routeTool(
        name: String,
        description: String,
        routePath: String,
        properties: Map<String, Map<String, Any>> = emptyMap(),
        required: List<String> = emptyList(),
        toPayload: (Map<String, Any>) -> Map<String, Any>
    ) = McpTool(name, description, schema(properties, required), routePath, toPayload)

    // ---------------------------------------------------------------------
    // Payload helpers — convert MCP-facing names to DecxRoutes payload names.
    // ---------------------------------------------------------------------

    private fun classSourcePayload(args: Map<String, Any>, smaliDefault: Boolean): Map<String, Any> = linkedMapOf(
        "cls" to classArg(args),
        "smali" to boolArg(args, "smali", smaliDefault),
        "filter" to linkedMapOf<String, Any>().apply { intArg(args, "limit", sanitizeLimit = true)?.let { put("limit", it) } },
        "page" to pageArg(args)
    )

    private fun filterPayload(args: Map<String, Any>): Map<String, Any> = linkedMapOf<String, Any>().apply {
        listArg(args, "include_packages")?.let { put("includes", it) }
        listArg(args, "exclude_packages")?.let { put("excludes", it) }
        intArg(args, "limit", sanitizeLimit = true)?.let { put("limit", it) }
        put("regex", boolArg(args, "regex", true))
    }

    private fun grepPayload(args: Map<String, Any>): Map<String, Any> = linkedMapOf<String, Any>().apply {
        put("limit", intArg(args, "limit", sanitizeLimit = true) ?: 100)
        put("regex", boolArg(args, "regex", true))
    }

    private fun pageArg(args: Map<String, Any>): Int = intArg(args, "page") ?: 1
    private fun classArg(args: Map<String, Any>): String = normalizeClassName(stringArg(args, "class_name"))
    private fun methodArg(args: Map<String, Any>): String = stringArg(args, "method_name")
    private fun fieldArg(args: Map<String, Any>): String = stringArg(args, "field_name")
    private fun interfaceArg(args: Map<String, Any>): String = stringArg(args, "interface_name")
    private fun resourceArg(args: Map<String, Any>): String = stringArg(args, "resource_name")

    private fun stringArg(args: Map<String, Any>, name: String): String {
        val text = args[name]?.toString()?.trim().orEmpty()
        if (text.isNotEmpty()) return text
        throw IllegalArgumentException("Missing required parameter: $name")
    }

    private fun normalizeClassName(value: String): String = value.replace('$', '.').trim()

    private fun boolArg(args: Map<String, Any>, name: String, default: Boolean): Boolean {
        return when (val raw = args[name] ?: return default) {
            is Boolean -> raw
            is String -> raw.equals("true", ignoreCase = true)
            else -> default
        }
    }

    private const val MAX_LIMIT = 10_000

    private fun intArg(args: Map<String, Any>, name: String, sanitizeLimit: Boolean = false): Int? {
        return when (val raw = args[name] ?: return null) {
            is Int -> raw
            is Long -> raw.toInt()
            is Double -> raw.toInt()
            is Float -> raw.toInt()
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull()
            else -> null
        }?.let {
            if (!sanitizeLimit) return@let it
            if (it <= 0) null  // 0 or negative → unlimited
            else it.coerceAtMost(MAX_LIMIT)
        }
    }

    private fun listArg(args: Map<String, Any>, name: String): List<String>? {
        val raw = args[name] ?: return null
        return when (raw) {
            is Iterable<*> -> raw.mapNotNull { it?.toString()?.trim() }.filter { it.isNotEmpty() }
            is Array<*> -> raw.mapNotNull { it?.toString()?.trim() }.filter { it.isNotEmpty() }
            is String -> raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }
            else -> null
        }
    }
}
