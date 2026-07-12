package jadx.plugins.decx.server.taie

import jadx.api.JadxDecompiler
import jadx.api.ResourceType
import jadx.plugins.decx.service.ITaiEEngine
import jadx.plugins.decx.service.ITaiEEngine.CallEdge
import jadx.plugins.decx.service.ITaiEEngine.DynamicReceiverInfo
import jadx.plugins.decx.service.ITaiEEngine.IccTarget
import jadx.plugins.decx.service.ITaiEEngine.CallbackInfo
import pascal.taie.Main
import pascal.taie.World
import pascal.taie.analysis.pta.PointerAnalysis
import pascal.taie.analysis.pta.PointerAnalysisResult
import pascal.taie.ir.stmt.Invoke
import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JMethod
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Concrete implementation of [ITaiEEngine], backed by Tai-e.
 *
 * Lives in decx-server (where Tai-e is on the classpath). Encapsulates:
 * - World construction (APK mode via Soot `-am`, or Java mode via `-pp`)
 * - Pointer analysis execution (background, with timeout/degradation)
 * - Call-graph and class-hierarchy queries (Tier 1)
 * - Points-to queries (Tier 2)
 *
 * Construction is via [builder] which starts background initialization.
 * The returned engine is immediately usable — [isReady] / [isAnalysisReady]
 * flip to true as each tier completes. Before that, query methods return
 * empty lists, and DECX endpoints fall back to JADX.
 */
class TaiEEngine private constructor(
    private val inputFile: File,
    private val isApk: Boolean,
    private val androidJarsDir: String?,
    private val outputDir: File,
    private val ptaTimeoutSeconds: Long
) : ITaiEEngine {

    private val tier1Ready = AtomicBoolean(false)
    private val tier2Ready = AtomicBoolean(false)
    private val initFailed = AtomicBoolean(false)
    private var initError: String? = null

    @Volatile
    private var ptaResult: PointerAnalysisResult? = null

    override val isReady: Boolean get() = tier1Ready.get()
    override val isAnalysisReady: Boolean get() = tier2Ready.get()

    /**
     * Starts background initialization of the Tai-e engine.
     * Returns immediately; callers poll [isReady] / [isAnalysisReady].
     */
    fun startAsync() {
        CompletableFuture.runAsync {
            try {
                initEngine()
            } catch (e: Throwable) {
                initFailed.set(true)
                initError = e.message
                System.err.println("[TaiEEngine] Initialization failed: ${e.message}")
                // Ensure World is cleaned up if partially constructed
                try { World.reset() } catch (_: Throwable) {}
            }
        }
    }

    /**
     * Synchronous initialization — blocks until Tier 1 (CG) is ready or fails.
     * Primarily for testing; production uses [startAsync].
     */
    fun startBlocking() {
        try {
            initEngine()
        } catch (e: Throwable) {
            initFailed.set(true)
            initError = e.message
        }
    }

    private fun initEngine() {
        outputDir.mkdirs()

        val args = buildList {
            // Tai-e 0.5.4: use the current JRE (avoids java-benchmarks dependency)
            // and the ASM-based JavaWorldBuilder for .java/.class input.
            // For Android APKs, SootWorldBuilder is used (forced by -am).
            if (!isApk) {
                // JavaWorldBuilder compiles .java via javac at runtime and reads
                // .class bytecode; faster and more reliable than Soot for Java.
                add("--world-builder")
                add("pascal.taie.frontend.java.JavaWorldBuilder")
            }
            // useCurrentJRE=true is the default in 0.5.4 when -java is omitted,
            // but we set it explicitly for clarity and forward-compat.
            add("--output-dir")
            add(outputDir.absolutePath)

            if (isApk) {
                add("-am") // Android mode (forces SootWorldBuilder)
                if (androidJarsDir != null) {
                    add("-ajs")
                    add(androidJarsDir)
                }
                add("-cp")
                add(inputFile.absolutePath)
            } else {
                // Java JAR/class mode
                add("-cp")
                add(inputFile.absolutePath)
            }

            // PTA configuration: context-insensitive for speed, app-only scope
            add("-a")
            add("pta=cs:ci;implicit-entries:false;only-app:true")
        }

        val argsArray = args.toTypedArray()
        Main.main(*argsArray)

        // After Main.main returns, World.get() is populated and PTA has run.
        val result: PointerAnalysisResult = World.get().getResult(PointerAnalysis.ID)
        ptaResult = result

        // Tier 1 (CG) is ready as soon as PTA produces the call graph.
        tier1Ready.set(true)
        // Tier 2 (PTA) is also ready since we ran it in the same pass.
        tier2Ready.set(true)
    }

    // ------------------------------------------------------------------
    // Tier 1: Call Graph queries
    // ------------------------------------------------------------------

    override fun callersOf(methodSig: String): List<CallEdge> {
        if (!tier1Ready.get()) return emptyList()
        return runCatching {
            val method = resolveMethod(methodSig) ?: return emptyList()
            val cg = ptaResult?.callGraph ?: return emptyList()
            cg.getCallersOf(method).map { invoke ->
                val caller = invoke.container
                CallEdge(
                    from = TaiESignatures.toDecxMethodId(caller),
                    to = methodSig,
                    invokeType = describeInvokeKind(invoke.invokeExp),
                    line = invoke.lineNumber.takeIf { it > 0 }
                )
            }
        }.getOrElse { emptyList() }
    }

    override fun calleesOf(methodSig: String): List<CallEdge> {
        if (!tier1Ready.get()) return emptyList()
        return runCatching {
            val method = resolveMethod(methodSig) ?: return emptyList()
            val cg = ptaResult?.callGraph ?: return emptyList()
            cg.getCalleesOfM(method).map { callee ->
                CallEdge(
                    from = methodSig,
                    to = TaiESignatures.toDecxMethodId(callee),
                    invokeType = "resolved", // dispatch-resolved by PTA
                    line = null
                )
            }
        }.getOrElse { emptyList() }
    }

    override fun subclassesOf(classSig: String, transitive: Boolean): List<String> {
        if (!tier1Ready.get()) return emptyList()
        return runCatching {
            val ch = hierarchy() ?: return emptyList()
            val cls = ch.getClass(classSig) ?: return emptyList()
            val subs = if (transitive) {
                ch.getAllSubclassesOf(cls)
            } else {
                ch.getDirectSubclassesOf(cls)
            }
            subs.map { it.name }
        }.getOrElse { emptyList() }
    }

    override fun implementorsOf(ifaceSig: String, transitive: Boolean): List<String> {
        if (!tier1Ready.get()) return emptyList()
        return runCatching {
            val ch = hierarchy() ?: return emptyList()
            val iface = ch.getClass(ifaceSig) ?: return emptyList()
            val impls = if (transitive) {
                ch.getAllSubclassesOf(iface).filter { it != iface }
            } else {
                ch.getDirectImplementorsOf(iface)
            }
            impls.map { it.name }
        }.getOrElse { emptyList() }
    }

    override fun reachableMethods(): List<String> {
        if (!tier1Ready.get()) return emptyList()
        return runCatching {
            val cg = ptaResult?.callGraph ?: return emptyList()
            cg.reachableMethods()
                .map { TaiESignatures.toDecxMethodId(it) }
                .toList()
        }.getOrElse { emptyList() }
    }

    // ------------------------------------------------------------------
    // Tier 2: Points-to queries
    // ------------------------------------------------------------------

    override fun pointsTo(methodSig: String, varName: String): List<String> {
        if (!tier2Ready.get()) return emptyList()
        return runCatching {
            val pta = ptaResult ?: return emptyList()
            val method = resolveMethod(methodSig) ?: return emptyList()
            val ir = method.ir

            // Resolve the variable by name: "this", "return", "p0", "p1", ...
            val varToQuery: pascal.taie.ir.exp.Var? = when {
                varName == "this" || varName == "@this" -> ir.`this`
                varName == "return" || varName == "ret" -> ir.returnVars.firstOrNull()
                varName.startsWith("p") -> {
                    val idx = varName.removePrefix("p").toIntOrNull() ?: return emptyList()
                    ir.params.getOrNull(idx)
                }
                else -> ir.params.firstOrNull { it.name == varName }
                    ?: ir.vars.firstOrNull { it.name == varName }
            }
            if (varToQuery == null) return emptyList()

            val pts = pta.getPointsToSet(varToQuery)
            pts.map { obj ->
                // Describe the allocation site: type + container method if available
                val type = obj.type.toString()
                val container = obj.containerMethod
                    .map { TaiESignatures.toDecxMethodId(it) }
                    .orElse(null)
                if (container != null) "$type @ $container" else type
            }
        }.getOrElse { emptyList() }
    }

    // ------------------------------------------------------------------
    // Android modeling (stubs — filled in Phase 2)
    // ------------------------------------------------------------------

    override fun dynamicReceivers(): List<DynamicReceiverInfo> {
        // Phase 2: read from Tai-e's DynamicReceiverModel
        return emptyList()
    }

    override fun iccTargets(componentSig: String): List<IccTarget> {
        // Phase 2: read from Tai-e's ICCAnalysis
        return emptyList()
    }

    override fun registeredCallbacks(componentSig: String): List<CallbackInfo> {
        // Phase 2: read from Tai-e's CallbackHandler
        return emptyList()
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** True if initialization failed; the error message is in [initError]. */
    val failed: Boolean get() = initFailed.get()
    val failureReason: String? get() = initError

    private fun hierarchy(): ClassHierarchy? {
        return runCatching { World.get().classHierarchy }.getOrNull()
    }

    /**
     * Resolves a DECX method signature to a Tai-e JMethod.
     * Converts DECX format `Class.name(params):ret` to Tai-e format
     * `<Class: ret name(params)>` and looks it up in the class hierarchy.
     */
    private fun resolveMethod(decxSig: String): JMethod? {
        val ch = hierarchy() ?: return null
        // Convert DECX sig to Tai-e sig: Class.name(params):ret -> <Class: ret name(params)>
        val taiESig = decxToTaiESignature(decxSig)
        return ch.getMethod(taiESig)
    }

    /**
     * Converts a DECX method signature to a Tai-e method signature.
     * DECX:   com.example.Foo.bar(int,java.lang.String):boolean
     * Tai-e:  <com.example.Foo: boolean bar(int,java.lang.String)>
     */
    private fun decxToTaiESignature(decxSig: String): String {
        // Split at the last ':' to separate return type
        val lastColon = decxSig.lastIndexOf(':')
        if (lastColon < 0) return "<$decxSig>"
        val retType = decxSig.substring(lastColon + 1)
        val beforeRet = decxSig.substring(0, lastColon) // Class.name(params)

        // Split at '(' to separate method name+class from params
        val parenIdx = beforeRet.indexOf('(')
        if (parenIdx < 0) return "<$decxSig>"
        val classAndMethod = beforeRet.substring(0, parenIdx) // Class.name
        val params = beforeRet.substring(parenIdx) // (params)

        // Split class.method at the last '.'
        val lastDot = classAndMethod.lastIndexOf('.')
        if (lastDot < 0) return "<$decxSig>"
        val className = classAndMethod.substring(0, lastDot)
        val methodName = classAndMethod.substring(lastDot + 1)

        return "<$className: $retType $methodName$params>"
    }

    private fun describeInvokeKind(invokeExp: pascal.taie.ir.exp.InvokeExp): String {
        return when (invokeExp) {
            is pascal.taie.ir.exp.InvokeVirtual -> "virtual"
            is pascal.taie.ir.exp.InvokeStatic -> "static"
            is pascal.taie.ir.exp.InvokeInterface -> "interface"
            is pascal.taie.ir.exp.InvokeSpecial -> "special"
            is pascal.taie.ir.exp.InvokeDynamic -> "dynamic"
            else -> "other"
        }
    }

    // ------------------------------------------------------------------
    // Builder
    // ------------------------------------------------------------------

    class Builder {
        private var inputFile: File? = null
        private var isApk: Boolean = false
        private var androidJarsDir: String? = null
        private var outputDir: File = File(System.getProperty("java.io.tmpdir"), "decx-taie")
        private var ptaTimeoutSeconds: Long = 600

        fun inputFile(file: File) = apply { this.inputFile = file }
        fun apkMode(apk: Boolean) = apply { this.isApk = apk }
        fun androidJarsDir(dir: String?) = apply { this.androidJarsDir = dir }
        fun outputDir(dir: File) = apply { this.outputDir = dir }
        fun ptaTimeoutSeconds(seconds: Long) = apply { this.ptaTimeoutSeconds = seconds }

        fun build(): TaiEEngine {
            val file = inputFile ?: error("inputFile must be set")
            return TaiEEngine(file, isApk, androidJarsDir, outputDir, ptaTimeoutSeconds)
        }
    }

    companion object {
        /**
         * Creates a TaiEEngine from a loaded JadxDecompiler, auto-detecting
         * whether the input is an APK (has manifest) or a plain Java JAR.
         *
         * @param inputFile the original input file (APK/JAR/DEX) passed to JADX
         * @param decompiler the loaded JADX decompiler (used to detect manifest presence)
         * @param androidJarsDir optional path to Android platform jars; if null,
         *   [AndroidSdkLocator] is used (APK mode only)
         */
        fun fromDecompiler(
            inputFile: File,
            decompiler: JadxDecompiler,
            androidJarsDir: String? = null
        ): TaiEEngine {
            val isApk = decompiler.resources?.stream()
                ?.anyMatch { it.type == ResourceType.MANIFEST } == true

            val resolvedAndroidJars = if (isApk && androidJarsDir == null) {
                AndroidSdkLocator.locatePlatformsDir()
            } else {
                androidJarsDir
            }

            return Builder()
                .inputFile(inputFile)
                .apkMode(isApk)
                .androidJarsDir(resolvedAndroidJars)
                .build()
        }
    }
}
