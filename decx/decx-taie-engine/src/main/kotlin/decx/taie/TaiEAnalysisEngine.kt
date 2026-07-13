package decx.taie

import pascal.taie.World
import pascal.taie.analysis.pta.PointerAnalysis
import pascal.taie.analysis.pta.PointerAnalysisResult
import pascal.taie.analysis.pta.plugin.taint.CallSource
import pascal.taie.analysis.pta.plugin.taint.IndexRef
import pascal.taie.analysis.pta.plugin.taint.Sink
import pascal.taie.analysis.pta.plugin.taint.Source
import pascal.taie.analysis.pta.plugin.taint.TaintAnalysis
import pascal.taie.analysis.pta.plugin.taint.TaintConfig
import pascal.taie.analysis.pta.plugin.taint.TaintConfigProvider
import pascal.taie.analysis.pta.plugin.util.InvokeUtils
import pascal.taie.ir.stmt.Invoke
import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JMethod
import pascal.taie.language.type.TypeSystem
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Core Tai-e analysis engine: World construction, PTA, call-graph queries,
 * and rule-based taint analysis.
 *
 * Taint analysis is performed by Tai-e's TaintAnalysis plugin, which is
 * integrated into the PTA pass. Rules are converted to TaintConfigProvider
 * and passed to PTA at initialization time. After PTA completes, taint flows
 * are extracted and stored per-rule for on-demand querying.
 *
 * This runs inside the TaiEEngine process (decx-taie-engine module).
 */
class TaiEAnalysisEngine(
    private val inputFile: File,
    private val isApk: Boolean,
    private val androidJarsDir: String?,
    private val outputDir: File,
    private val rulesDir: File?
) {

    @Volatile
    private var ptaResult: PointerAnalysisResult? = null

    @Volatile
    private var ready = false

    @Volatile
    private var analysisReady = false

    private var loadedRules: List<VulnRule> = emptyList()

    /** Taint flows from preset rules, keyed by rule ID. */
    private var taintFlowsByRule: Map<String, List<TaintResult.TaintPath>> = emptyMap()

    val isReady: Boolean get() = ready
    val isAnalysisReady: Boolean get() = analysisReady

    /**
     * Initializes the engine: loads rules, builds World, runs PTA with taint analysis.
     * All preset rules are registered as a TaintConfigProvider before PTA starts,
     * so source→sink taint flows are computed during the PTA pass itself.
     */
    fun initialize() {
        outputDir.mkdirs()

        // Load rules first and register them with the TaintConfigProvider
        if (rulesDir != null && rulesDir.isDirectory) {
            loadedRules = RuleLoader.load(rulesDir)
            System.err.println("[TaiEEngine] Loaded ${loadedRules.size} rule(s) from ${rulesDir.absolutePath}")
        }
        DecxTaintConfigProvider.presetRules = loadedRules

        // For Android APK mode: extract bundled android.jar.
        val effectiveAndroidJars = if (isApk) {
            androidJarsDir ?: extractBundledAndroidJar()
        } else {
            null
        }

        // Build World + run PTA with taint analysis enabled.
        // The DecxTaintConfigProvider converts all loaded rules into
        // Tai-e Source/Sink objects for the TaintAnalysis plugin.
        val ptaOptions = if (loadedRules.isNotEmpty()) {
            "cs:ci;implicit-entries:false;only-app:true;time-limit:600;" +
                "taint-config-providers:[decx.taie.DecxTaintConfigProvider]"
        } else {
            "cs:ci;implicit-entries:false;only-app:true;time-limit:600"
        }

        val args = buildList {
            if (!isApk) {
                add("--world-builder")
                add("pascal.taie.frontend.java.JavaWorldBuilder")
            }
            add("--output-dir")
            add(outputDir.absolutePath)

            if (isApk) {
                add("-am")
                if (effectiveAndroidJars != null) {
                    add("-ajs")
                    add(effectiveAndroidJars)
                }
                add("-cp")
                add(inputFile.absolutePath)
            } else {
                add("-cp")
                add(inputFile.absolutePath)
            }

            add("-a")
            add("pta=$ptaOptions")
        }

        pascal.taie.Main.main(*args.toTypedArray())

        val result: PointerAnalysisResult = World.get().getResult(PointerAnalysis.ID)
        ptaResult = result

        // Extract taint flows from PTA result (if taint analysis was enabled)
        if (loadedRules.isNotEmpty()) {
            extractTaintFlows(result)
        }

        ready = true
        analysisReady = true
        System.err.println("[TaiEEngine] Initialization complete, ${taintFlowsByRule.values.sumOf { it.size }} taint flow(s) found")
    }

    // ------------------------------------------------------------------
    // CG / xref queries
    // ------------------------------------------------------------------

    fun callersOf(decxMethodSig: String): List<TaintResult.CallEdge> {
        val pta = ptaResult ?: return emptyList()
        val method = resolveMethod(decxMethodSig) ?: return emptyList()
        return runCatching {
            pta.callGraph.getCallersOf(method).map { invoke ->
                TaintResult.CallEdge(
                    from = TaiESignatures.toDecxMethodId(invoke.container),
                    to = decxMethodSig,
                    invokeType = describeInvokeKind(invoke),
                    line = invoke.lineNumber.takeIf { it > 0 }
                )
            }
        }.getOrElse { emptyList() }
    }

    fun calleesOf(decxMethodSig: String): List<TaintResult.CallEdge> {
        val pta = ptaResult ?: return emptyList()
        val method = resolveMethod(decxMethodSig) ?: return emptyList()
        return runCatching {
            pta.callGraph.getCalleesOfM(method).map { callee ->
                TaintResult.CallEdge(
                    from = decxMethodSig,
                    to = TaiESignatures.toDecxMethodId(callee),
                    invokeType = "resolved",
                    line = null
                )
            }
        }.getOrElse { emptyList() }
    }

    fun subclassesOf(classSig: String, transitive: Boolean): List<String> {
        val ch = hierarchy() ?: return emptyList()
        return runCatching {
            val cls = ch.getClass(classSig) ?: return emptyList()
            val subs = if (transitive) ch.getAllSubclassesOf(cls) else ch.getDirectSubclassesOf(cls)
            subs.map { it.name }
        }.getOrElse { emptyList() }
    }

    fun implementorsOf(ifaceSig: String, transitive: Boolean): List<String> {
        val ch = hierarchy() ?: return emptyList()
        return runCatching {
            val iface = ch.getClass(ifaceSig) ?: return emptyList()
            val impls = if (transitive) {
                ch.getAllSubclassesOf(iface).filter { it != iface }
            } else {
                ch.getDirectImplementorsOf(iface)
            }
            impls.map { it.name }
        }.getOrElse { emptyList() }
    }

    fun pointsTo(decxMethodSig: String, varName: String): List<String> {
        val pta = ptaResult ?: return emptyList()
        return runCatching {
            val method = resolveMethod(decxMethodSig) ?: return emptyList()
            val ir = method.ir
            val varToQuery: pascal.taie.ir.exp.Var? = when {
                varName == "this" || varName == "@this" -> ir.`this`
                varName == "return" || varName == "ret" -> ir.returnVars.firstOrNull()
                varName.startsWith("p") -> {
                    val idx = varName.removePrefix("p").toIntOrNull() ?: return emptyList()
                    ir.params.getOrNull(idx)
                }
                else -> ir.vars.firstOrNull { it.name == varName }
            } ?: return emptyList()

            pta.getPointsToSet(varToQuery).map { obj ->
                val type = obj.type.toString()
                val container = obj.containerMethod
                    .map { TaiESignatures.toDecxMethodId(it) }
                    .orElse(null)
                if (container != null) "$type @ $container" else type
            }
        }.getOrElse { emptyList() }
    }

    // ------------------------------------------------------------------
    // Rule queries (three core interfaces)
    // ------------------------------------------------------------------

    /** Interface 1: return loaded rule summaries */
    fun getRuleSummaries(): List<TaintResult.RuleSummary> {
        return loadedRules.map { rule ->
            TaintResult.RuleSummary(
                id = rule.id ?: "",
                name = rule.name ?: "",
                description = rule.description ?: "",
                parameters = rule.parameters?.map { p ->
                    TaintResult.RuleParameter(
                        name = p.name, type = p.type, description = p.description,
                        required = p.required, defaultValue = p.defaultValue
                    )
                }
            )
        }
    }

    /** Interface 2: execute a preset rule by ID */
    fun investigate(ruleId: String, params: Map<String, String>): List<TaintResult.TaintPath> {
        // Taint flows for preset rules are precomputed during PTA initialization.
        return taintFlowsByRule[ruleId] ?: emptyList()
    }

    /** Interface 3: execute a custom inline rule */
    fun investigateCustom(ruleYaml: String, params: Map<String, String>): List<TaintResult.TaintPath> {
        // Custom rules require re-running PTA with the new taint config.
        // This is expensive but correct — the TaintAnalysis plugin must run
        // during PTA to track variable-level data flow.
        val rule = RuleLoader.parseYaml(ruleYaml) ?: return emptyList()
        val resolved = rule.resolveParams(params).copy(id = "custom")
        return rerunWithRule(resolved)
    }

    /**
     * Extracts taint flows from the PTA result, groups them by rule ID.
     * Called after PTA completes (taint analysis runs as a PTA plugin).
     */
    @Suppress("UNCHECKED_CAST")
    private fun extractTaintFlows(ptaResult: PointerAnalysisResult) {
        // List all available result keys for debugging
        val resultKeys = try {
            val method = ptaResult.javaClass.methods.find { it.name == "getResult" && it.parameterCount == 1 }
            // Can't easily enumerate; try by direct key
            System.err.println("[TaiEEngine] Checking TaintAnalysis result on PTA result object: ${ptaResult.javaClass.name}")
        } catch (_: Exception) {}

        val rawResult = try {
            ptaResult.getResult<Any>(TaintAnalysis::class.java.name)
        } catch (e: Exception) {
            System.err.println("[TaiEEngine] TaintAnalysis result not found on PTA result: ${e.message}")
            // Try World as fallback
            try {
                World.get().getResult<Any>(TaintAnalysis::class.java.name).also {
                    System.err.println("[TaiEEngine] Found on World instead!")
                }
            } catch (e2: Exception) {
                System.err.println("[TaiEEngine] TaintAnalysis result not found anywhere: ${e2.message}")
                return
            }
        }
        if (rawResult == null) {
            System.err.println("[TaiEEngine] Taint analysis returned null — TaintAnalysis plugin may not have run")
            return
        }
        val flows = rawResult as? Set<*>
        if (flows == null) {
            System.err.println("[TaiEEngine] Taint analysis result type unexpected: ${rawResult.javaClass.name}")
            return
        }
        System.err.println("[TaiEEngine] Found ${flows.size} taint flow(s) from TaintAnalysis")

        // Group flows by which rule's source/sink they match
        val byRule = mutableMapOf<String, MutableList<TaintResult.TaintPath>>()

        for (flow in flows) {
            val taintFlow = flow as pascal.taie.analysis.pta.plugin.taint.TaintFlow
            val ruleId = DecxTaintConfigProvider.matchFlowToRule(taintFlow) ?: "unknown"
            val flowStr = taintFlow.toString()
            val path = TaintResult.TaintPath(
                ruleId = ruleId,
                source = flowStr.substringBefore(" -> "),
                sink = flowStr.substringAfter(" -> ", flowStr),
                steps = listOf(TaintResult.TaintStep(
                    method = flowStr,
                    line = 0,
                    desc = flowStr
                ))
            )
            byRule.getOrPut(ruleId) { mutableListOf() }.add(path)
        }

        taintFlowsByRule = byRule
        System.err.println("[TaiEEngine] Extracted ${flows.size} taint flow(s) across ${byRule.size} rule(s)")
    }

    /**
     * Re-runs PTA with a single custom rule as the taint config.
     * Resets World first, then runs PTA + TaintAnalysis with the custom rule.
     */
    private fun rerunWithRule(rule: VulnRule): List<TaintResult.TaintPath> {
        // Store the custom rule for the TaintConfigProvider to pick up
        DecxTaintConfigProvider.customRule = rule

        try {
            World.reset()
            val effectiveAndroidJars = if (isApk) {
                androidJarsDir ?: extractBundledAndroidJar()
            } else null

            val args = buildList {
                if (!isApk) {
                    add("--world-builder")
                    add("pascal.taie.frontend.java.JavaWorldBuilder")
                }
                add("--output-dir")
                add(File(outputDir, "custom-${System.currentTimeMillis()}").absolutePath)
                if (isApk) {
                    add("-am")
                    if (effectiveAndroidJars != null) { add("-ajs"); add(effectiveAndroidJars) }
                    add("-cp"); add(inputFile.absolutePath)
                } else {
                    add("-cp"); add(inputFile.absolutePath)
                }
                add("-a")
                add("pta=cs:ci;implicit-entries:false;only-app:true;time-limit:600;" +
                    "taint-config-providers:[decx.taie.DecxTaintConfigProvider]")
            }

            pascal.taie.Main.main(*args.toTypedArray())
            val result: PointerAnalysisResult = World.get().getResult(PointerAnalysis.ID)

            // Extract flows for this custom rule
            val flows = try {
                result.getResult<Set<pascal.taie.analysis.pta.plugin.taint.TaintFlow>>(
                    TaintAnalysis::class.java.name
                )
            } catch (_: Exception) { return emptyList() }

            return flows.map { flow ->
                val flowStr = flow.toString()
                TaintResult.TaintPath(
                    ruleId = "custom",
                    source = flowStr.substringBefore(" -> "),
                    sink = flowStr.substringAfter(" -> ", flowStr),
                    steps = listOf(TaintResult.TaintStep(
                        method = flowStr,
                        line = 0,
                        desc = flowStr
                    ))
                )
            }
        } finally {
            DecxTaintConfigProvider.customRule = null
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private fun hierarchy(): ClassHierarchy? =
        runCatching { World.get().classHierarchy }.getOrNull()

    private fun resolveMethod(decxSig: String): JMethod? {
        val ch = hierarchy() ?: return null
        val taiESig = TaiESignatures.decxToTaiESignature(decxSig)
        return ch.getMethod(taiESig)
    }

    private fun describeInvokeKind(invoke: Invoke): String {
        return when {
            invoke.isVirtual -> "virtual"
            invoke.isStatic -> "static"
            invoke.isInterface -> "interface"
            invoke.isSpecial -> "special"
            invoke.isDynamic -> "dynamic"
            else -> "other"
        }
    }

    /**
     * Extracts the bundled android.jar from classpath resources to a temp dir.
     * Creates the `platforms/android-<N>/android.jar` directory structure that
     * Soot expects (it picks the API level from the APK's targetSdk).
     * Since the bundled android.jar (API 34) is backward-compatible, we create
     * symlinks for common API levels (21-34) all pointing to the same jar.
     * Returns the parent "platforms" directory path (for Tai-e's -ajs).
     */
    private fun extractBundledAndroidJar(): String? {
        return try {
            val cacheDir = File(System.getProperty("java.io.tmpdir"), "decx-taie-cache")
            val platformsDir = File(cacheDir, "platforms")
            platformsDir.mkdirs()

            // Extract the base android.jar if not cached
            val baseJar = File(cacheDir, "android-base.jar")
            if (!baseJar.exists() || baseJar.length() == 0L) {
                val resource: InputStream = javaClass.getResourceAsStream("/android-platforms/android.jar")
                    ?: return null
                Files.copy(resource, baseJar.toPath(), StandardCopyOption.REPLACE_EXISTING)
                resource.close()
                System.err.println("[TaiEEngine] Extracted bundled android.jar (${baseJar.length() / 1024 / 1024}MB)")
            }

            // Create platform dirs for common API levels (Soot picks one by targetSdk)
            for (apiLevel in 21..34) {
                val versionDir = File(platformsDir, "android-$apiLevel")
                val jarLink = File(versionDir, "android.jar")
                if (jarLink.exists()) continue
                versionDir.mkdirs()
                try {
                    Files.createSymbolicLink(jarLink.toPath(), baseJar.toPath())
                } catch (_: Exception) {
                    // Symlinks may fail on Windows without privileges — copy instead
                    if (!jarLink.exists()) {
                        Files.copy(baseJar.toPath(), jarLink.toPath(), StandardCopyOption.REPLACE_EXISTING)
                    }
                }
            }
            platformsDir.absolutePath
        } catch (e: Exception) {
            System.err.println("[TaiEEngine] Failed to extract bundled android.jar: ${e.message}")
            null
        }
    }

}

