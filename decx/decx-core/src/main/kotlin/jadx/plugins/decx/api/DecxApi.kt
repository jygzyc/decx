package jadx.plugins.decx.api

/**
 * Type-safe API interface for Decx core services.
 * Server and Plugin both consume this API — it has zero HTTP/transport dependencies.
 */
interface DecxApi {

    // ==================== Common Service ====================

    fun getClasses(filter: DecxFilter): DecxApiResult
    fun searchGlobalKey(key: String, filter: DecxFilter): DecxApiResult
    fun searchClassKey(cls: String, key: String, filter: DecxFilter): DecxApiResult
    fun searchMethod(mth: String): DecxApiResult
    fun getClassSource(cls: String, smali: Boolean, filter: DecxFilter): DecxApiResult
    fun getMethodSource(mth: String, smali: Boolean): DecxApiResult

    // ==================== Context Service ====================

    fun getClassContext(cls: String): DecxApiResult
    fun getMethodContext(mth: String): DecxApiResult
    fun getMethodCfg(mth: String): DecxApiResult
    fun getMethodXref(mth: String): DecxApiResult
    fun getFieldXref(fld: String): DecxApiResult
    fun getClassXref(cls: String): DecxApiResult
    fun getImplementOfInterface(iface: String): DecxApiResult
    fun getSubclasses(cls: String): DecxApiResult

    // ==================== Android Service ====================

    fun getAidlInterfaces(filter: DecxFilter): DecxApiResult
    fun getAppManifest(): DecxApiResult
    fun getMainActivity(): DecxApiResult
    fun getApplication(): DecxApiResult
    fun getExportedComponents(filter: DecxFilter): DecxApiResult
    fun getDeepLinks(): DecxApiResult
    fun getDynamicReceivers(filter: DecxFilter): DecxApiResult
    fun getAllResources(filter: DecxFilter): DecxApiResult
    fun getResourceFile(res: String): DecxApiResult
    fun getStrings(): DecxApiResult
    fun getSystemServiceImpl(iface: String): DecxApiResult

    // ==================== UI Service ====================
    fun getSelectedText(): DecxApiResult
    fun getSelectedClass(): DecxApiResult
}
