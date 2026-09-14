package jadx.plugins.decx.api

import jadx.api.JadxDecompiler
import jadx.plugins.decx.service.AndroidService
import jadx.plugins.decx.service.ContextService
import jadx.plugins.decx.service.CommonService
import jadx.plugins.decx.service.DecxService
import jadx.plugins.decx.service.UiBackedService
import jadx.plugins.decx.utils.AnalysisResultUtils

/**
 * Default implementation of [DecxApi].
 *
 * Delegates to individual service classes. There is no generic response cache here:
 * decompilation guarding/caching and metadata indexing are owned by
 * [jadx.plugins.decx.utils.DecompileGuard].
 */
class DecxApiImpl(
    decompiler: JadxDecompiler,
    uiService: UiBackedService? = null
) : DecxApi {

    private val commonService = CommonService(decompiler)
    private val contextService = ContextService(decompiler)
    private val androidService = AndroidService(decompiler)
    private val services: List<DecxService> = listOfNotNull(commonService, contextService, androidService, uiService)

    // ==================== Common Service ====================

    override fun getClasses(filter: DecxFilter): DecxApiResult =
        commonService.handleGetClasses(filter)

    override fun searchGlobalKey(key: String, filter: DecxFilter): DecxApiResult =
        commonService.handleSearchGlobalKey(key, filter)

    override fun getClassSource(cls: String, smali: Boolean, filter: DecxFilter): DecxApiResult =
        contextService.handleGetClassSource(cls, smali, filter.forSourcePrefix())

    override fun searchClassKey(cls: String, key: String, filter: DecxFilter): DecxApiResult =
        commonService.handleSearchClassKey(cls, key, filter)

    override fun searchMethod(mth: String): DecxApiResult =
        commonService.handleSearchMethod(mth)

    // ==================== Context Service ====================

    override fun getClassContext(cls: String): DecxApiResult =
        contextService.handleGetClassContext(cls)

    override fun getMethodSource(mth: String, smali: Boolean): DecxApiResult =
        commonService.handleGetMethodSource(mth, smali)

    override fun getMethodContext(mth: String): DecxApiResult =
        contextService.handleGetMethodContext(mth)

    override fun getMethodCfg(mth: String): DecxApiResult =
        contextService.handleGetMethodCfg(mth)

    override fun getMethodXref(mth: String): DecxApiResult =
        contextService.handleGetMethodXref(mth)

    override fun getFieldXref(fld: String): DecxApiResult =
        contextService.handleGetFieldXref(fld)

    override fun getClassXref(cls: String): DecxApiResult =
        contextService.handleGetClassXref(cls)

    override fun getImplementations(iface: String): DecxApiResult =
        contextService.handleGetImplementOfInterface(iface)

    override fun getSubclasses(cls: String): DecxApiResult =
        contextService.handleGetSubclasses(cls)

    // ==================== Android App Service ====================

    override fun getAidlInterfaces(filter: DecxFilter): DecxApiResult =
        androidService.handleGetAidlInterfaces(filter)

    override fun getAppManifest(): DecxApiResult =
        androidService.handleGetAppManifest()

    override fun getMainActivity(): DecxApiResult =
        androidService.handleGetMainActivity()

    override fun getApplication(): DecxApiResult =
        androidService.handleGetApplication()

    override fun getExportedComponents(filter: DecxFilter): DecxApiResult =
        androidService.handleGetExportedComponents(filter)

    override fun getDeepLinks(): DecxApiResult =
        androidService.handleGetDeepLinks()

    override fun getDynamicReceivers(filter: DecxFilter): DecxApiResult =
        androidService.handleGetDynamicReceivers(filter)

    override fun getAllResources(filter: DecxFilter): DecxApiResult =
        androidService.handleGetAllResources(filter.forResourceNames())

    override fun getResourceFile(res: String): DecxApiResult =
        androidService.handleGetResourceFile(res)

    override fun getStrings(): DecxApiResult =
        androidService.handleGetStrings()

    override fun getSystemServiceImpl(iface: String): DecxApiResult =
        androidService.handleGetSystemServiceImpl(iface)

    // ==================== UI Service ====================

    override fun getSelectedText(): DecxApiResult =
        findUiService()?.handleGetSelectedText()
            ?: DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SELECTED_TEXT, emptyMap(), DecxError.NOT_GUI_MODE))

    override fun getSelectedClass(): DecxApiResult =
        findUiService()?.handleGetSelectedClass()
            ?: DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SELECTED_CLASS, emptyMap(), DecxError.NOT_GUI_MODE))

    private fun findUiService(): UiBackedService? {
        return services.firstOrNull { it.isUi } as? UiBackedService
    }

    private fun DecxFilter.forSourcePrefix(): DecxFilter = copy(
        includes = emptyList(),
        excludes = emptyList(),
        caseSensitive = false,
        regex = true
    )

    private fun DecxFilter.forResourceNames(): DecxFilter = copy(
        excludes = emptyList(),
        caseSensitive = false
    )
}
