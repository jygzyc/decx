package jadx.plugins.decx.api

import jadx.api.JadxDecompiler
import jadx.plugins.decx.service.AndroidService
import jadx.plugins.decx.service.ContextService
import jadx.plugins.decx.service.CommonService
import jadx.plugins.decx.service.DecxService
import jadx.plugins.decx.service.UiBackedService
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.CacheUtils

/**
 * Default implementation of [DecxApi].
 * Delegates to individual service classes, with optional caching support.
 */
class DecxApiImpl(
    decompiler: JadxDecompiler,
    private val cacheEnabled: Boolean = true,
    uiService: UiBackedService? = null
) : DecxApi {

    private val commonService = CommonService(decompiler)
    private val contextService = ContextService(decompiler)
    private val androidService = AndroidService(decompiler)
    private val services: List<DecxService> = listOfNotNull(commonService, contextService, androidService, uiService)

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
