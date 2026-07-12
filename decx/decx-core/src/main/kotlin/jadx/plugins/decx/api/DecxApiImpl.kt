package jadx.plugins.decx.api

import jadx.api.JadxDecompiler
import jadx.plugins.decx.service.AndroidService
import jadx.plugins.decx.service.ContextService
import jadx.plugins.decx.service.CommonService
import jadx.plugins.decx.service.DecxService
import jadx.plugins.decx.service.ITaiEEngine
import jadx.plugins.decx.service.TaintService
import jadx.plugins.decx.service.UiBackedService
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.CacheUtils
import jadx.plugins.decx.utils.ItemKind

/**
 * Default implementation of [DecxApi].
 * Delegates to individual service classes, with optional caching support.
 */
class DecxApiImpl(
    decompiler: JadxDecompiler,
    private val cacheEnabled: Boolean = true,
    uiService: UiBackedService? = null,
    taiEEngine: ITaiEEngine? = null
) : DecxApi {

    private val commonService = CommonService(decompiler)
    private val contextService = ContextService(decompiler, taiEEngine)
    private val androidService = AndroidService(decompiler)
    private val taintService = TaintService(decompiler, taiEEngine)
    private val services: List<DecxService> = listOfNotNull(commonService, contextService, androidService, uiService, taintService)

    // ==================== Common Service ====================

    override fun getClasses(filter: DecxFilter): DecxApiResult {
        return maybeCached("getClasses", filter.toQuery()) { commonService.handleGetClasses(filter) }
    }

    override fun searchGlobalKey(key: String, filter: DecxFilter): DecxApiResult {
        val params = mapOf("key" to key) + filter.toQuery()
        return maybeCached("searchGlobalKey", params) { commonService.handleSearchGlobalKey(key, filter) }
    }

    override fun getClassSource(cls: String, smali: Boolean, filter: DecxFilter): DecxApiResult {
        val sourceFilter = filter.forSourcePrefix()
        val params = mapOf("cls" to cls, "smali" to smali) + sourceFilter.toQuery()
        return maybeCached("getClassSource", params) {
            contextService.handleGetClassSource(cls, smali, sourceFilter)
        }
    }

    override fun searchClassKey(cls: String, key: String, filter: DecxFilter): DecxApiResult {
        val params = mapOf("cls" to cls, "key" to key) + filter.toQuery()
        return maybeCached("searchClassKey", params) {
            commonService.handleSearchClassKey(cls, key, filter)
        }
    }

    override fun searchMethod(mth: String): DecxApiResult {
        return maybeCached("searchMethod", mapOf("mth" to mth)) { commonService.handleSearchMethod(mth) }
    }

    // ==================== Context Service ====================

    override fun getClassContext(cls: String): DecxApiResult {
        return maybeCached("getClassContext", mapOf("cls" to cls)) { contextService.handleGetClassContext(cls) }
    }

    override fun getMethodSource(mth: String, smali: Boolean): DecxApiResult {
        return maybeCached("getMethodSource", mapOf("mth" to mth, "smali" to smali)) {
            commonService.handleGetMethodSource(mth, smali)
        }
    }

    override fun getMethodContext(mth: String): DecxApiResult {
        return maybeCached("getMethodContext", mapOf("mth" to mth)) { contextService.handleGetMethodContext(mth) }
    }

    override fun getMethodCfg(mth: String): DecxApiResult {
        return maybeCached("getMethodCfg", mapOf("mth" to mth)) { contextService.handleGetMethodCfg(mth) }
    }

    override fun getMethodXref(mth: String): DecxApiResult {
        return maybeCached("getMethodXref", mapOf("mth" to mth)) { contextService.handleGetMethodXref(mth) }
    }

    override fun getFieldXref(fld: String): DecxApiResult {
        return maybeCached("getFieldXref", mapOf("fld" to fld)) { contextService.handleGetFieldXref(fld) }
    }

    override fun getClassXref(cls: String): DecxApiResult {
        return maybeCached("getClassXref", mapOf("cls" to cls)) { contextService.handleGetClassXref(cls) }
    }

    override fun getImplementOfInterface(iface: String): DecxApiResult {
        return maybeCached("getImplementOfInterface", mapOf("iface" to iface)) {
            contextService.handleGetImplementOfInterface(iface)
        }
    }

    override fun getSubclasses(cls: String): DecxApiResult {
        return maybeCached("getSubclasses", mapOf("cls" to cls)) { contextService.handleGetSubclasses(cls) }
    }

    // ==================== Android App Service ====================

    override fun getAidlInterfaces(filter: DecxFilter): DecxApiResult {
        return maybeCached("getAidlInterfaces", filter.toQuery()) {
            androidService.handleGetAidlInterfaces(filter)
        }
    }

    override fun getAppManifest(): DecxApiResult {
        return androidService.handleGetAppManifest()
    }

    override fun getMainActivity(): DecxApiResult {
        return androidService.handleGetMainActivity()
    }

    override fun getApplication(): DecxApiResult {
        return androidService.handleGetApplication()
    }

    override fun getExportedComponents(filter: DecxFilter): DecxApiResult {
        return maybeCached("getExportedComponents", filter.toQuery()) {
            androidService.handleGetExportedComponents(filter)
        }
    }

    override fun getDeepLinks(): DecxApiResult {
        return androidService.handleGetDeepLinks()
    }

    override fun getDynamicReceivers(filter: DecxFilter): DecxApiResult {
        return maybeCached("getDynamicReceivers", filter.toQuery()) {
            androidService.handleGetDynamicReceivers(filter)
        }
    }

    override fun getAllResources(filter: DecxFilter): DecxApiResult {
        val resourceFilter = filter.forResourceNames()
        return maybeCached("getAllResources", resourceFilter.toQuery()) {
            androidService.handleGetAllResources(resourceFilter)
        }
    }

    override fun getResourceFile(res: String): DecxApiResult {
        return androidService.handleGetResourceFile(res)
    }

    override fun getStrings(): DecxApiResult {
        return androidService.handleGetStrings()
    }

    override fun getSystemServiceImpl(iface: String): DecxApiResult {
        return androidService.handleGetSystemServiceImpl(iface)
    }

    // ==================== UI Service ====================

    override fun getSelectedText(): DecxApiResult {
        return findUiService()?.handleGetSelectedText()
            ?: DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SELECTED_TEXT, emptyMap(), DecxError.NOT_GUI_MODE))
    }

    override fun getSelectedClass(): DecxApiResult {
        return findUiService()?.handleGetSelectedClass()
            ?: DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SELECTED_CLASS, emptyMap(), DecxError.NOT_GUI_MODE))
    }

    // ==================== Vuln Hunt Service ====================

    // ==================== Taint Service ====================

    override fun getTaintRules(): DecxApiResult = taintService.handleGetRules()

    override fun investigate(ruleId: String, params: Map<String, String>): DecxApiResult =
        taintService.handleInvestigate(ruleId, params)

    override fun investigateCustom(ruleYaml: String, params: Map<String, String>): DecxApiResult =
        taintService.handleInvestigateCustom(ruleYaml, params)

    override fun getPointsTo(mth: String, variable: String): DecxApiResult {
        val query = mapOf("method" to mth, "variable" to variable)
        val engine = taintService.getEngine()
        if (engine == null || !engine.isAnalysisReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.POINTS_TO, query, DecxError.SERVICE_ERROR,
                    if (engine == null) "TaiEEngine not available"
                    else "TaiEEngine pointer analysis not ready")
            )
        }
        val pts = engine.pointsTo(mth, variable)
        val items = pts.mapIndexed { i, desc ->
            AnalysisResultUtils.item(
                id = "$mth#$variable#$i", kind = ItemKind.EVIDENCE,
                title = "Allocation: $desc", content = desc,
                meta = linkedMapOf("method" to mth, "variable" to variable, "source" to "taie")
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.POINTS_TO, query, items))
    }

    override fun getTaieDynamicReceivers(): DecxApiResult {
        val query = emptyMap<String, Any>()
        val engine = taintService.getEngine()
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.DYNAMIC_RECEIVERS_TAIE, query, DecxError.SERVICE_ERROR,
                    "TaiEEngine not available or not ready")
            )
        }
        val receivers = engine.dynamicReceivers()
        val items = receivers.mapIndexed { i, recv ->
            AnalysisResultUtils.item(
                id = "dynamic-receiver-$i", kind = ItemKind.EVIDENCE,
                title = "Dynamic receiver: ${recv.receiverClass}",
                content = "${recv.receiverClass} registered in ${recv.registerMethod}",
                meta = linkedMapOf(
                    "register_method" to recv.registerMethod,
                    "receiver_class" to recv.receiverClass,
                    "action_filters" to recv.actionFilters, "source" to "taie"
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.DYNAMIC_RECEIVERS_TAIE, query, items))
    }

    override fun getIccTargets(component: String): DecxApiResult {
        val query = mapOf("component" to component)
        val engine = taintService.getEngine()
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.ICC_TARGETS, query, DecxError.SERVICE_ERROR,
                    "TaiEEngine not available or not ready")
            )
        }
        val targets = engine.iccTargets(component)
        val items = targets.mapIndexed { i, tgt ->
            AnalysisResultUtils.item(
                id = "icc-target-$i", kind = ItemKind.EVIDENCE,
                title = "ICC: ${tgt.sourceComponent} -> ${tgt.targetComponent.ifEmpty { "?" }}",
                content = "${tgt.intentCall} from ${tgt.sourceComponent}",
                meta = linkedMapOf(
                    "source_component" to tgt.sourceComponent,
                    "intent_call" to tgt.intentCall,
                    "target_component" to tgt.targetComponent,
                    "is_explicit" to tgt.isExplicit, "source" to "taie"
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.ICC_TARGETS, query, items))
    }

    override fun getCallbacks(component: String): DecxApiResult {
        val query = mapOf("component" to component)
        val engine = taintService.getEngine()
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.CALLBACKS, query, DecxError.SERVICE_ERROR,
                    "TaiEEngine not available or not ready")
            )
        }
        val callbacks = engine.registeredCallbacks(component)
        val items = callbacks.mapIndexed { i, cb ->
            AnalysisResultUtils.item(
                id = "callback-$i", kind = ItemKind.EVIDENCE,
                title = "Callback: ${cb.callbackMethod}",
                content = "${cb.hostClass} registers ${cb.callbackMethod} (${cb.interfaceType})",
                meta = linkedMapOf(
                    "host_class" to cb.hostClass,
                    "callback_method" to cb.callbackMethod,
                    "interface_type" to cb.interfaceType, "source" to "taie"
                )
            )
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.CALLBACKS, query, items))
    }

    override fun getCallGraph(mth: String, direction: String): DecxApiResult {
        val query = mapOf("method" to mth, "direction" to direction)
        val engine = taintService.getEngine()
        if (engine == null || !engine.isReady) {
            return DecxApiResult.fail(
                AnalysisResultUtils.error(DecxKind.CALL_GRAPH, query, DecxError.SERVICE_ERROR,
                    if (engine == null) "TaiEEngine not available"
                    else "TaiEEngine not ready")
            )
        }
        val items = mutableListOf<Map<String, Any>>()
        if (direction == "callers" || direction == "both") {
            engine.callersOf(mth).forEachIndexed { i, edge ->
                items.add(AnalysisResultUtils.item(
                    id = "$mth#caller-$i", kind = ItemKind.CALL_EDGE,
                    title = "Caller: ${edge.from}", content = edge.from,
                    meta = linkedMapOf("direction" to "caller", "from" to edge.from,
                        "to" to mth, "invoke_type" to edge.invokeType, "line" to (edge.line ?: 0))
                ))
            }
        }
        if (direction == "callees" || direction == "both") {
            engine.calleesOf(mth).forEachIndexed { i, edge ->
                items.add(AnalysisResultUtils.item(
                    id = "$mth#callee-$i", kind = ItemKind.CALL_EDGE,
                    title = "Callee: ${edge.to}", content = edge.to,
                    meta = linkedMapOf("direction" to "callee", "from" to mth,
                        "to" to edge.to, "invoke_type" to edge.invokeType)
                ))
            }
        }
        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.CALL_GRAPH, query, items))
    }

    private fun findUiService(): UiBackedService? {
        return services.firstOrNull { it.isUi } as? UiBackedService
    }

    // ==================== Cache ====================

    private fun DecxFilter.forSourcePrefix(): DecxFilter {
        return copy(
            includes = emptyList(),
            excludes = emptyList(),
            caseSensitive = false,
            regex = true
        )
    }

    private fun DecxFilter.forResourceNames(): DecxFilter {
        return copy(
            excludes = emptyList(),
            caseSensitive = false
        )
    }

    private fun maybeCached(endpoint: String, params: Map<String, Any>, loader: () -> DecxApiResult): DecxApiResult {
        return if (cacheEnabled) cached(endpoint, params, loader) else loader()
    }

    private fun cached(endpoint: String, params: Map<String, Any>, loader: () -> DecxApiResult): DecxApiResult {
        CacheUtils.get(endpoint, params)?.let {
            @Suppress("UNCHECKED_CAST")
            return DecxApiResult(true, it as Map<String, Any>)
        }
        val result = loader()
        if (result.success) {
            CacheUtils.put(endpoint, params, result.data)
        }
        return result
    }
}
