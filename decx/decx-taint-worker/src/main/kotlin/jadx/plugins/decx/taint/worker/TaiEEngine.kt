package jadx.plugins.decx.taint.worker

import pascal.taie.Main
import pascal.taie.World
import pascal.taie.analysis.pta.PointerAnalysis
import pascal.taie.analysis.pta.PointerAnalysisResult
import pascal.taie.analysis.pta.plugin.taint.TaintAnalysis
import pascal.taie.analysis.pta.plugin.taint.TaintFlow
import jadx.plugins.decx.taint.protocol.TaintFlowDto
import java.io.File

/**
 * Runs Tai-e taint analysis for one request. Ported from the decx-taint-poc
 * PoC; runs inside the worker JVM which has its own classpath (Tai-e +
 * modified Soot/FlowDroid jars) isolated from the DECX server.
 */
object TaiEEngine {

    class EngineException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

    /**
     * Analyze an APK with the given resolved config fragments.
     *
     * @param apk absolute APK path
     * @param platforms Android SDK platforms dir (or null to use default)
     * @param analysis analysis fragment (algorithm/cs/scope/...)
     * @param limits limits fragment (timeouts)
     * @param taint taint rules fragment (sources/sinks/...)
     * @param raw raw Tai-e plan options (optional escape hatch)
     * @param progress progress callback invoked with (stage, message)
     * @return list of taint flows (empty when none found)
     */
    fun analyze(
        apk: String,
        platforms: String?,
        analysis: Map<String, Any>,
        limits: Map<String, Any>,
        taint: Map<String, Any>,
        raw: Map<String, Any>?,
        progress: (stage: String, message: String) -> Unit
    ): Pair<List<TaintFlowDto>, Map<String, Any>> {
        val apkFile = File(apk)
        if (!apkFile.isFile) throw EngineException("APK not found: $apk")

        progress("preparing", "writing taint config")
        val taintConfigFile = writeTaintConfig(taint, raw)
        progress("preparing", "assembling Tai-e options")

        val args = buildArgs(apk, platforms, analysis, limits, taintConfigFile, raw)

        progress("building", "building analysis world")
        val t0 = System.currentTimeMillis()
        try {
            Main.main(*args)
        } catch (e: Throwable) {
            throw EngineException("Tai-e analysis failed: ${e.message}", e)
        }
        val durationMs = System.currentTimeMillis() - t0
        progress("analyzing", "pointer analysis + taint finished in ${durationMs}ms")

        val flows = fetchTaintFlows()
        val meta = linkedMapOf<String, Any>(
            "durationMs" to durationMs,
            "flowCount" to flows.size
        )
        return flows.map(::toDto) to meta
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private fun buildArgs(
        apk: String,
        platforms: String?,
        analysis: Map<String, Any>,
        limits: Map<String, Any>,
        taintConfigFile: File,
        raw: Map<String, Any>?
    ): Array<String> {
        val algorithm = analysis["algorithm"] as? String ?: "pta"
        if (algorithm != "pta") {
            throw EngineException(
                "algorithm '$algorithm' unsupported: Tai-e 0.5.4 runs taint via the pta analysis"
            )
        }
        val cs = analysis["contextSensitivity"] as? String ?: "ci"
        val scope = analysis["scope"] as? String ?: "APP"

        // pta options (Tai-e 0.5.4 option names only; unknown keys abort).
        val ptaOptions = buildString {
            append("cs:$cs")
            append(";taint-config:${taintConfigFile.absolutePath}")
            if (analysis["distinguishStrings"] == true) append(";distinguish-string-constants:all")
            val timeLimit = (limits["maxPointerAnalyzeTimeSec"] as? Number)?.toInt()
            if (timeLimit != null && timeLimit > 0) append(";time-limit:$timeLimit")
            // raw escape hatch: extra pta options, e.g. { pta: { "merge-string-builders": false } }
            (raw?.get("pta") as? Map<*, *>)?.forEach { (k, v) -> append(";$k:$v") }
        }
        val ptaArg = "pta=$ptaOptions"

        return buildList {
            add("-cp"); add(apk)
            add("-am")                       // Android mode
            if (platforms != null) { add("-ajs"); add(platforms) }
            add("-scope"); add(scope)
            add("-a"); add(ptaArg)
            // Omit -java/--jre-dir: worker resolves javaVersion from APK
            // (AndroidJavaVersionInfer) and loads JRE from the worker's cwd
            // (java-benchmarks/JREs), mirroring the PoC setup.
            add("--output-dir"); add(File(System.getProperty("java.io.tmpdir"), "decx-taint-out-${System.nanoTime()}").absolutePath)
            // raw escape hatch: extra Tai-e CLI options
            (raw?.get("cli") as? List<*>)?.forEach { add(it.toString()) }
        }.toTypedArray()
    }

    private fun writeTaintConfig(taint: Map<String, Any>, raw: Map<String, Any>?): File {
        // If the raw escape hatch carries an explicit taint-config path, prefer it.
        raw?.get("taint-config-path")?.let { path ->
            val file = File(path.toString())
            if (file.isFile) return file
        }

        val yaml = buildString {
            append("sources:\n")
            (taint["sources"] as? List<*>)?.forEach { append("  - ").append(yamlEntry(it)).append("\n") }
            append("sinks:\n")
            (taint["sinks"] as? List<*>)?.forEach { append("  - ").append(yamlEntry(it)).append("\n") }
            append("transfers:\n")
            (taint["transfers"] as? List<*>)?.forEach { append("  - ").append(yamlEntry(it)).append("\n") }
            append("sanitizers:\n")
            (taint["sanitizers"] as? List<*>)?.forEach { append("  - ").append(yamlEntry(it)).append("\n") }
            if (taint["callSiteMode"] == true) append("call-site-mode: true\n")
        }
        val file = File(System.getProperty("java.io.tmpdir"), "decx-taint-config-${System.nanoTime()}.yml")
        file.writeText(yaml)
        return file
    }

    private fun yamlEntry(entry: Any?): String {
        val map = entry as? Map<*, *> ?: return ""
        return map.entries.joinToString(", ", "{", "}") { (k, v) ->
            // index/from/to are Tai-e keywords: "result"/"base"/"0" must stay
            // unquoted or Tai-e resolves them as instance field accesses.
            // Numbers must not become doubles: YAML `index: 2` parsed by jackson
            // arrives as Double 2.0 and must serialize back as `2`, not `2.0`.
            if (k == "index" || k == "from" || k == "to") "$k: ${scalar(v)}" else "$k: \"$v\""
        }
    }

    private fun scalar(v: Any?): String = when (v) {
        is Double -> if (v % 1.0 == 0.0) v.toLong().toString() else v.toString()
        is Float -> if (v % 1.0f == 0.0f) v.toLong().toString() else v.toString()
        else -> v.toString()
    }

    @Suppress("UNCHECKED_CAST")
    private fun fetchTaintFlows(): Set<TaintFlow> {
        val paResult: PointerAnalysisResult = World.get().getResult(PointerAnalysis.ID)
        return paResult.getResult(TaintAnalysis::class.java.name)
    }

    private fun toDto(flow: TaintFlow): TaintFlowDto {
        val text = flow.toString()
        // "TaintFlow{source -> sink}"
        val inner = text.removePrefix("TaintFlow{").removeSuffix("}")
        val (sourcePart, sinkPart) = inner.split(" -> ", limit = 2)
        return TaintFlowDto(
            source = sourcePart.trim(),
            sink = sinkPart.trim(),
            sourceMethod = extractMethod(sourcePart),
            sinkMethod = extractMethod(sinkPart),
            sourceLine = extractLine(sourcePart),
            sinkLine = extractLine(sinkPart)
        )
    }

    /** "<pkg.Cls: ret method(args)>[idx@Lline]" -> "<pkg.Cls: ret method(args)>" */
    private fun extractMethod(part: String): String {
        val end = part.indexOf(']')
        val head = if (end >= 0) part.substring(0, end) else part
        return head.trim()
    }

    private fun extractLine(part: String): Int? {
        val at = part.indexOf("@L")
        if (at < 0) return null
        val numStart = at + 2
        val numEnd = part.indexOf(']', numStart)
        val num = if (numEnd >= 0) part.substring(numStart, numEnd) else part.substring(numStart)
        return num.toIntOrNull()
    }
}
