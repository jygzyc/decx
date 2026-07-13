package decx.taie

import pascal.taie.World
import pascal.taie.analysis.pta.PointerAnalysis
import pascal.taie.analysis.pta.PointerAnalysisResult
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import pascal.taie.ir.stmt.Invoke
import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JMethod
import java.io.File

/**
 * Core Tai-e analysis engine: World construction, PTA, call-graph queries,
 * and rule-based taint analysis.
 *
 * This runs inside the TaiEEngine process (decx-taie-engine module).
 * It is NOT visible to decx-core — all communication goes through
 * TaiEEngineMain's JSON-RPC protocol.
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

    val isReady: Boolean get() = ready
    val isAnalysisReady: Boolean get() = analysisReady

    /**
     * Initializes the engine: builds World, runs PTA, loads rules.
     * This is a blocking call — may take minutes for large APKs.
     */
    fun initialize() {
        outputDir.mkdirs()

        // Load rules first (fast, no Tai-e dependency)
        if (rulesDir != null && rulesDir.isDirectory) {
            loadedRules = RuleLoader.load(rulesDir)
            System.err.println("[TaiEEngine] Loaded ${loadedRules.size} rule(s) from ${rulesDir.absolutePath}")
        }

        // For Android APK mode: extract bundled android.jar and set up
        // java-benchmarks/JREs/ working directory so Tai-e can find JRE classes.
        val effectiveAndroidJars = if (isApk) {
            androidJarsDir ?: extractBundledAndroidJar()
        } else {
            null
        }
        if (isApk) {
            setupJreWorkDir()
        }

        // Build World + run PTA
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

            // Memory-conservative PTA config
            add("-a")
            add("pta=cs:ci;implicit-entries:false;only-app:true;time-limit:600")
        }

        pascal.taie.Main.main(*args.toTypedArray())

        val result: PointerAnalysisResult = World.get().getResult(PointerAnalysis.ID)
        ptaResult = result
        ready = true
        analysisReady = true
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
        val rule = loadedRules.find { it.id == ruleId }
            ?: return emptyList()
        val resolved = rule.resolveParams(params)
        return executeRule(resolved)
    }

    /** Interface 3: execute a custom inline rule */
    fun investigateCustom(ruleYaml: String, params: Map<String, String>): List<TaintResult.TaintPath> {
        val rule = RuleLoader.parseYaml(ruleYaml) ?: return emptyList()
        val resolved = rule.resolveParams(params)
        return executeRule(resolved.copy(id = rule.id ?: "custom"))
    }

    // ------------------------------------------------------------------
    // Rule execution
    // ------------------------------------------------------------------

    private fun executeRule(rule: VulnRule): List<TaintResult.TaintPath> {
        val ch = hierarchy() ?: return emptyList()
        val pta = ptaResult ?: return emptyList()
        val cg = pta.callGraph

        val paths = mutableListOf<TaintResult.TaintPath>()

        // Resolve source methods from patterns
        val sourceMethods = rule.source.orEmpty().flatMap { spec ->
            MethodFinder.resolveMethods(spec.method, ch)
        }.distinct()

        // Resolve sink methods from patterns
        val sinkMethods = rule.sink.orEmpty().flatMap { spec ->
            MethodFinder.resolveMethods(spec.method, ch)
        }.distinct()

        if (sourceMethods.isEmpty() || sinkMethods.isEmpty()) return emptyList()

        // For each source, find callers and trace to sinks via call graph
        // This is a simplified taint analysis using the PTA call graph:
        // for each source method, find all callers; for each caller, check if
        // any sink method is reachable within trace_depth.
        val traceDepth = rule.traceDepth ?: 10

        for (source in sourceMethods) {
            val sourceSig = TaiESignatures.toDecxMethodId(source)
            val callers = cg.getCallersOf(source)

            for (invoke in callers) {
                val caller = invoke.container
                val callerSig = TaiESignatures.toDecxMethodId(caller)

                // Check if this caller (or its callees within traceDepth) reaches a sink
                val reachable = bfsReachable(caller, sinkMethods.toSet(), traceDepth, cg)
                for (sinkMethod in reachable) {
                    val sinkSig = TaiESignatures.toDecxMethodId(sinkMethod)
                    paths.add(TaintResult.TaintPath(
                        ruleId = rule.id ?: "custom",
                        source = sourceSig,
                        sink = sinkSig,
                        steps = listOf(
                            TaintResult.TaintStep(
                                method = callerSig,
                                line = invoke.lineNumber.takeIf { it > 0 } ?: 0,
                                desc = "calls $sourceSig"
                            )
                        )
                    ))
                }
            }
        }

        return paths.distinct()
    }

    /**
     * BFS from [start] to find any of [targets] within [maxDepth] call-graph edges.
     */
    private fun bfsReachable(
        start: JMethod,
        targets: Set<JMethod>,
        maxDepth: Int,
        cg: pascal.taie.analysis.graph.callgraph.CallGraph<Invoke, JMethod>
    ): Set<JMethod> {
        val found = mutableSetOf<JMethod>()
        val visited = mutableSetOf<JMethod>()
        val queue = ArrayDeque<Pair<JMethod, Int>>()
        queue.addLast(start to 0)
        visited.add(start)

        while (queue.isNotEmpty()) {
            val (method, depth) = queue.removeFirst()
            if (method in targets) {
                found.add(method)
            }
            if (depth >= maxDepth) continue

            val callees = runCatching { cg.getCalleesOfM(method) }.getOrElse { emptySet() }
            for (callee in callees) {
                if (callee !in visited) {
                    visited.add(callee)
                    queue.addLast(callee to depth + 1)
                }
            }
        }
        return found
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

    /**
     * Sets up the java-benchmarks/JREs/ directory that Tai-e's SootWorldBuilder
     * requires for Android mode. Tai-e needs real JRE .jar files (rt.jar etc.)
     * matching the APK's target Java version, not JDK 9+ module images.
     *
     * Downloads the JRE jars from pascal-lab/java-benchmarks on first run
     * (cached in temp dir, ~70MB one-time download). On subsequent runs the
     * cache is reused.
     */
    private fun setupJreWorkDir() {
        try {
            // Check if already set up in working directory
            val localJres = File("java-benchmarks/JREs")
            if (localJres.isDirectory && localJres.listFiles()?.isNotEmpty() == true) {
                System.err.println("[TaiEEngine] JREs already available at ${localJres.absolutePath}")
                return
            }

            // Download JRE jars to a cache dir, then symlink/copy into working dir
            val cacheDir = File(System.getProperty("java.io.tmpdir"), "decx-taie-cache/JREs")
            if (!cacheDir.isDirectory || cacheDir.listFiles()?.isEmpty() == true) {
                System.err.println("[TaiEEngine] Downloading JRE jars (one-time, ~70MB)...")
                downloadJreJars(cacheDir)
            }

            // Link each jre1.<version> from cache into working directory
            localJres.mkdirs()
            cacheDir.listFiles()?.forEach { versionDir ->
                if (versionDir.isDirectory && versionDir.name.startsWith("jre1.")) {
                    val link = File(localJres, versionDir.name)
                    if (!link.exists()) {
                        try {
                            Files.createSymbolicLink(link.toPath(), versionDir.toPath())
                        } catch (_: Exception) {
                            // Fallback: copy jar files
                            versionDir.copyRecursively(link, overwrite = true)
                        }
                    }
                }
            }
            System.err.println("[TaiEEngine] JREs ready at ${localJres.absolutePath}")
        } catch (e: Exception) {
            System.err.println("[TaiEEngine] Failed to set up JREs: ${e.message}")
        }
    }

    /**
     * Downloads JRE jars from pascal-lab/java-benchmarks GitHub repo.
     * Only downloads the directories needed (jre1.8 is the most common for Android).
     */
    private fun downloadJreJars(targetDir: File) {
        // Download individual jar files from GitHub raw content.
        // We focus on jre1.8 (most Android apps) and jre1.11 (newer apps).
        val baseUrl = "https://raw.githubusercontent.com/pascal-lab/java-benchmarks/main/JREs"
        for (ver in listOf(8, 11, 17)) {
            val verDir = File(targetDir, "jre1.$ver")
            verDir.mkdirs()
            val jars = listOf("rt.jar", "jce.jar", "jsse.jar", "charsets.jar", "resources.jar")
            for (jar in jars) {
                val target = File(verDir, jar)
                if (target.exists() && target.length() > 0) continue
                try {
                    val url = java.net.URI("$baseUrl/jre1.$ver/$jar").toURL()
                    java.net.HttpURLConnection.HTTP_OK
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 30000
                    conn.readTimeout = 60000
                    if (conn.responseCode == 200) {
                        Files.copy(conn.inputStream, target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                        System.err.println("[TaiEEngine]   Downloaded $jar (${target.length() / 1024}KB)")
                    }
                    conn.disconnect()
                } catch (e: Exception) {
                    System.err.println("[TaiEEngine]   Failed to download $jar: ${e.message}")
                }
            }
        }
    }
}
