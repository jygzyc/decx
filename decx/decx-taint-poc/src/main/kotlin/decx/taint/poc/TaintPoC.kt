package decx.taint.poc

import java.io.File
import java.nio.file.Files
import javax.tools.ToolProvider
import pascal.taie.Main
import pascal.taie.World
import pascal.taie.analysis.pta.PointerAnalysis
import pascal.taie.analysis.pta.PointerAnalysisResult
import pascal.taie.analysis.pta.plugin.taint.TaintAnalysis
import pascal.taie.analysis.pta.plugin.taint.TaintFlow

/**
 * DECX PoC: prove Tai-e can run in-process under decx's JVM 17 toolchain.
 *
 * Modes:
 *   (no args) / java   -> analyze a trivially-tainted Java program
 *   android [apkPath]  -> analyze an APK with Tai-e android mode (PacDroid)
 *
 * Disposable module. Run via:
 *   ./gradlew :decx-taint-poc:run
 *   ./gradlew :decx-taint-poc:run --args="android path/to/app.apk"
 */
fun main(args: Array<String>) {
    when (args.firstOrNull()) {
        "android" -> runAndroidPoC(args.drop(1).firstOrNull())
        else -> runJavaPoC()
    }
}

private fun fetchTaintFlows(): Set<TaintFlow> = try {
    val paResult: PointerAnalysisResult = World.get().getResult(PointerAnalysis.ID)
    paResult.getResult(TaintAnalysis::class.java.name)
} catch (e: Throwable) {
    println("[!] programmatic fetch failed: ${e.javaClass.simpleName}: ${e.message}")
    emptySet()
}

private fun report(flows: Set<TaintFlow>, okPredicate: (Set<TaintFlow>) -> Boolean, passedMsg: String) {
    println("\n=== RESULTS (programmatic API) ===")
    println("Detected ${flows.size} taint flow(s):")
    flows.forEach { println("  - $it") }
    println("\n=== VERDICT ===")
    if (okPredicate(flows)) println("✓ PoC PASSED: $passedMsg")
    else println("✗ PoC NEEDS REVIEW (see Tai-e log lines above).")
}

// ───────────────────────── Java mode ─────────────────────────

private fun runJavaPoC() {
    println("=== DECX Tai-e Taint PoC (Java mode) ===")
    val workDir = Files.createTempDirectory("decx-taint-poc-").toFile()
    val srcDir = File(workDir, "src").apply { mkdirs() }
    val classesDir = File(workDir, "classes").apply { mkdirs() }
    val outDir = File(workDir, "out").apply { mkdirs() }
    val taintConfig = File(workDir, "taint-config.yml")
    println("[*] work dir: $workDir")

    val cl = Thread.currentThread().contextClassLoader ?: ClassLoader.getSystemClassLoader()
    fun res(name: String): String =
        cl.getResourceAsStream("poc/$name")!!.bufferedReader().use { it.readText() }
    File(srcDir, "SourceSink.java").writeText(res("SourceSink.java"))
    File(srcDir, "NewLeak.java").writeText(res("NewLeak.java"))
    taintConfig.writeText(res("taint-config.yml"))

    val compiler = ToolProvider.getSystemJavaCompiler()
        ?: error("no system javac — run on a JDK, not a JRE")
    val rc = compiler.run(
        null, System.out, System.err,
        "-d", classesDir.absolutePath,
        File(srcDir, "SourceSink.java").absolutePath,
        File(srcDir, "NewLeak.java").absolutePath,
    )
    check(rc == 0) { "javac failed rc=$rc" }
    println("[*] compiled target -> $classesDir")

    val args = arrayOf(
        "-acp", classesDir.absolutePath,
        "-m", "NewLeak",
        // Omit -java/--jre-dir so Tai-e uses the running JDK via jrt:/.
        "-a", "pta=taint-config:${taintConfig.absolutePath}",
        "--output-dir", outDir.absolutePath,
    )
    println("[*] Tai-e args: ${args.joinToString(" ")}")

    runTaie(args, outDir)
    report(fetchTaintFlows(), { it.isNotEmpty() },
        "Tai-e runs in decx JVM 17 and detects the taint flow in-process.")
}

// ───────────────────────── Android mode ─────────────────────────

private fun runAndroidPoC(apkArg: String?) {
    println("=== DECX Tai-e Taint PoC (Android mode / PacDroid) ===")

    val apk = resolveApk(apkArg)
    val platforms = resolveAndroidPlatforms()
    val workDir = Files.createTempDirectory("decx-android-poc-").toFile()
    val outDir = File(workDir, "out").apply { mkdirs() }
    val taintConfig = File(workDir, "android-taint-config.yml")
    val cl = Thread.currentThread().contextClassLoader ?: ClassLoader.getSystemClassLoader()
    taintConfig.writeText(
        cl.getResourceAsStream("poc/android-taint-config.yml")!!
            .bufferedReader().use { it.readText() }
    )
    println("[*] apk       : $apk")
    println("[*] platforms : $platforms")
    println("[*] config    : $taintConfig")
    println("[*] output    : $outDir")

    val args = arrayOf(
        "-cp", apk.absolutePath,
        "-am",
        "-ajs", platforms.absolutePath,
        "-a", "pta=taint-config:${taintConfig.absolutePath}",
        "--output-dir", outDir.absolutePath,
    )
    println("[*] Tai-e args: ${args.joinToString(" ")}")

    runTaie(args, outDir)
    val flows = fetchTaintFlows()
    report(flows, { it.isNotEmpty() },
        "Tai-e Android (PacDroid) runs in decx JVM 17 and detects privacy taint flow(s).")
}

private fun resolveApk(apkArg: String?): File {
    apkArg?.let { return File(it).also { check(it.exists()) { "APK not found: $it" } } }
    System.getenv("DECX_POC_APK")?.let { return File(it).also { check(it.exists()) { "APK not found: $it" } } }
    // Default: decx's own test fixture (DroidBench sieve).
    val candidates = listOf(
        File("../decx-cli/tests/fixtures/sieve.apk"),   // relative to module projectDir
        File("../../decx-cli/tests/fixtures/sieve.apk"),
    )
    return candidates.firstOrNull { it.exists() }
        ?: error("No APK. Pass one: ./gradlew run --args=\"android /path/to/app.apk\"")
}

private fun resolveAndroidPlatforms(): File {
    System.getenv("ANDROID_SDK_ROOT")?.let { File(it, "platforms").takeIf(File::exists) }
        ?.let { return it }
    System.getenv("ANDROID_HOME")?.let { File(it, "platforms").takeIf(File::exists) }
        ?.let { return it }
    // Common install locations on this machine.
    listOf(
        "D:\\ProgramData\\Android\\Sdk\\platforms",
        "C:\\Users\\${System.getProperty("user.name")}\\AppData\\Local\\Android\\Sdk\\platforms",
    ).map { File(it) }.firstOrNull { it.exists() }
        ?.let { return it }
    error("Android SDK platforms/ not found. Set ANDROID_SDK_ROOT.")
}

private fun runTaie(args: Array<String>, outDir: File) {
    val t0 = System.currentTimeMillis()
    runCatching { Main.main(*args) }.onFailure { e ->
        println("[!] Tai-e threw: ${e.javaClass.simpleName}: ${e.message}")
        e.printStackTrace(System.out)
    }
    println("[*] Tai-e finished in ${System.currentTimeMillis() - t0}ms")
    val taiELog = File(outDir, "tai-e.log")
    if (taiELog.exists()) {
        val lines = taiELog.readLines()
        if (lines.isNotEmpty()) {
            println("--- tai-e.log (last 15 non-empty lines) ---")
            lines.filter { it.isNotBlank() }.takeLast(15).forEach { println("  $it") }
        }
    }
}
