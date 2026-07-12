package jadx.plugins.decx.service

/**
 * Contract between DECX core and the Tai-e static analysis engine.
 *
 * This interface lives in decx-core and has zero Tai-e imports, so that
 * decx-core (and the JADX GUI plugin) can reference it without pulling in
 * the Tai-e dependency. The concrete implementation [TaiEEngine] lives in
 * decx-server, which has Tai-e on its classpath.
 *
 * The engine serves as an "evidence collector" — it queries structural
 * program facts (call graph, class hierarchy, points-to, Android modeling)
 * and returns them as DECX-signature-keyed data. It does NOT make vulnerability
 * judgments; that is left to the AI consuming the evidence via DECX endpoints.
 *
 * Two readiness tiers:
 * - [isReady] (Tier 1): CallGraph + ClassHierarchy are available. Fast (seconds).
 *   Powers xref replacement (callersOf, calleesOf, subclasses, implementors).
 * - [isAnalysisReady] (Tier 2): Pointer analysis is complete. Slow (minutes).
 *   Powers variable tracking (pointsTo, variable flow) and taint evidence.
 *
 * When the engine is null (GUI plugin mode) or not yet ready, all DECX
 * endpoints fall back to the existing JADX-based logic.
 */
interface ITaiEEngine {

    /** Tier 1 readiness: CallGraph and ClassHierarchy are available. */
    val isReady: Boolean

    /** Tier 2 readiness: pointer analysis is complete. */
    val isAnalysisReady: Boolean

    // ------------------------------------------------------------------
    // Tier 1: Call Graph + Class Hierarchy (replaces JADX xref)
    // ------------------------------------------------------------------

    /**
     * Returns all methods that call [methodSig] (i.e., callers of the method).
     * Replaces JADX's `JavaMethod.useIn` single-level reverse lookup.
     *
     * @param methodSig DECX canonical method signature, e.g.
     *   `com.example.Foo.bar(int,java.lang.String):boolean`
     */
    fun callersOf(methodSig: String): List<CallEdge>

    /**
     * Returns all methods called by [methodSig] (i.e., callees of the method),
     * with virtual dispatch resolved to concrete implementations.
     * Replaces JADX's `MethodNode.instructions` intra-method scan.
     */
    fun calleesOf(methodSig: String): List<CallEdge>

    /**
     * Returns all subclasses of [classSig].
     * @param transitive if true, includes transitive descendants;
     *   if false, only direct subclasses.
     * Replaces the smali `.super` text scan.
     */
    fun subclassesOf(classSig: String, transitive: Boolean): List<String>

    /**
     * Returns all classes that implement [ifaceSig].
     * @param transitive if true, includes transitive implementors;
     *   if false, only direct implementors.
     * Replaces the smali `.implement` text scan.
     */
    fun implementorsOf(ifaceSig: String, transitive: Boolean): List<String>

    /**
     * Returns all methods reachable from the entry points in the call graph.
     * Useful for dead-code elimination and reachability filtering.
     */
    fun reachableMethods(): List<String>

    // ------------------------------------------------------------------
    // Tier 2: Pointer Analysis (variable tracking / evidence collection)
    // ------------------------------------------------------------------

    /**
     * Returns the allocation sites (as DECX signatures or type names) that
     * the given variable can point to.
     *
     * @param methodSig the method containing the variable
     * @param varName variable identifier: "return", "this", "p0", "p1", etc.
     * @return list of allocation-site descriptions (e.g. "new com.example.Foo" or
     *   the allocating method signature). Empty if PTA is not ready or the
     *   variable has no points-to information.
     */
    fun pointsTo(methodSig: String, varName: String): List<String>

    // ------------------------------------------------------------------
    // Android vulnerability modeling (evidence collection)
    // ------------------------------------------------------------------

    /**
     * Returns dynamically-registered broadcast receivers discovered by static
     * analysis (Tai-e's DynamicReceiverModel). Each entry records the method
     * that called `registerReceiver`, the receiver class, and action filters.
     *
     * Only available in Android (APK) mode. Returns empty list for Java JARs.
     */
    fun dynamicReceivers(): List<DynamicReceiverInfo>

    /**
     * Returns ICC (inter-component communication) targets resolved from
     * `startActivity` / `sendBroadcast` / `startService` calls.
     *
     * @param componentSig the source component class signature, or empty string
     *   to get all ICC targets in the app.
     * Only available in Android (APK) mode.
     */
    fun iccTargets(componentSig: String): List<IccTarget>

    /**
     * Returns callback methods registered by the given component (e.g.
     * `OnClickListener.onClick` registered via `setOnClickListener`).
     *
     * @param componentSig the component class signature, or empty string
     *   to get all registered callbacks.
     * Only available in Android (APK) mode.
     */
    fun registeredCallbacks(componentSig: String): List<CallbackInfo>

    // ------------------------------------------------------------------
    // Evidence data classes (pure Kotlin, no Tai-e types)
    // ------------------------------------------------------------------

    /**
     * A directed call-graph edge.
     *
     * @param from caller method signature (DECX format)
     * @param to callee method signature (DECX format)
     * @param invokeType the invoke kind: "virtual", "static", "interface",
     *   "special", "other"
     * @param line source line number of the call site, or null if unknown
     */
    data class CallEdge(
        val from: String,
        val to: String,
        val invokeType: String,
        val line: Int?
    )

    /**
     * A dynamically-registered broadcast receiver.
     *
     * @param registerMethod the method that called `registerReceiver` (DECX sig)
     * @param receiverClass the receiver class name
     * @param actionFilters Intent action filter strings registered
     */
    data class DynamicReceiverInfo(
        val registerMethod: String,
        val receiverClass: String,
        val actionFilters: List<String>
    )

    /**
     * An inter-component communication target.
     *
     * @param sourceComponent the component initiating the ICC (class name)
     * @param intentCall the method call that triggers ICC (DECX sig, e.g.
     *   `android.app.Activity.startActivity(android.content.Intent):void`)
     * @param targetComponent the resolved target component class name, or
     *   empty string if unresolved (implicit intent with no match)
     * @param isExplicit true if the intent was explicit (named target),
     *   false if implicit (action-based)
     */
    data class IccTarget(
        val sourceComponent: String,
        val intentCall: String,
        val targetComponent: String,
        val isExplicit: Boolean
    )

    /**
     * A registered callback method.
     *
     * @param hostClass the class that registered the callback
     * @param callbackMethod the callback method (DECX sig)
     * @param interfaceType the listener interface type (e.g.
     *   `android.view.View$OnClickListener`)
     */
    data class CallbackInfo(
        val hostClass: String,
        val callbackMethod: String,
        val interfaceType: String
    )
}
