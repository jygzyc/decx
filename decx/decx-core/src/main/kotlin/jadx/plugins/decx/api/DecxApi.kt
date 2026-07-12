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

    // ==================== Vuln Hunt Service (Tai-e evidence collection) ====================
    /** Lists available investigation rules loaded from ~/.decx/rules/. */
    fun getVulnRules(): DecxApiResult
    /** Executes an investigation rule by ID, collecting structured evidence. */
    fun investigate(ruleId: String): DecxApiResult
    /** Queries the points-to set of a variable in a method (pointer analysis). */
    fun getPointsTo(mth: String, variable: String): DecxApiResult
    /** Lists dynamically-registered broadcast receivers (Tai-e Android modeling). */
    fun getTaieDynamicReceivers(): DecxApiResult
    /** Lists ICC (inter-component communication) targets for a component. */
    fun getIccTargets(component: String): DecxApiResult
    /** Lists registered callbacks (e.g. OnClickListener) for a component. */
    fun getCallbacks(component: String): DecxApiResult
    /** Returns call-graph neighbors of a method (callers and/or callees). */
    fun getCallGraph(mth: String, direction: String): DecxApiResult
}
