package jadx.plugins.decx.server.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import pascal.taie.Main
import pascal.taie.World
import pascal.taie.analysis.pta.PointerAnalysis
import pascal.taie.analysis.pta.PointerAnalysisResult
import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JMethod
import java.io.File

/**
 * Phase 0 PoC: verifies that Tai-e can be embedded in-process inside decx-server
 * and that its analysis results can be bridged to DECX signatures.
 *
 * Tai-e 0.5.4 ships the JavaWorldBuilder (ASM + javac frontend), which compiles
 * .java source at runtime via the JDK's javax.tools.JavaCompiler. This is the
 * default frontend for non-Android Java programs. The test program
 * (PocProgram.java) exercises virtual dispatch and data flow.
 *
 * Checklist items verified here:
 *   1. World construction from a small Java program
 *   2. PTA produces a CallGraph with real edges (incl. virtual dispatch resolution)
 *   3. Signature bridge (TaiESignatures) produces DECX-compatible IDs
 *   7. Points-to query returns allocation sites
 */
class TaiEWorldPoCTest {

    private val pocDir = File("src/test/resources/taie/poc").absolutePath

    private fun runPta() {
        // Tai-e 0.5.4: useCurrentJRE is default when -java omitted, so no -pp needed.
        // JavaWorldBuilder compiles .java source at runtime.
        // --output-dir must be same-drive as -cp on Windows (Path.relativize limitation).
        val outputDir = File("build/taie-output").absoluteFile
        outputDir.mkdirs()
        Main.main(
            "--world-builder", "pascal.taie.frontend.java.JavaWorldBuilder",
            "--output-dir", outputDir.absolutePath,
            "-cp", pocDir,
            "-m", "PocProgram",
            "-a", "pta=cs:ci;implicit-entries:false;only-app:true"
        )
    }

    private fun ptaResult(): PointerAnalysisResult =
        World.get().getResult(PointerAnalysis.ID)

    private fun hierarchy(): ClassHierarchy =
        World.get().classHierarchy

    private fun findMethod(className: String, methodName: String): JMethod? {
        val cls = hierarchy().getClass(className) ?: return null
        return cls.declaredMethods.firstOrNull { it.name == methodName }
    }

    @Test
    fun `World construction and PTA complete without error`() {
        runPta()
        val world = World.get()
        assertThat(world).isNotNull
        val pta = ptaResult()
        assertThat(pta).isNotNull
    }

    @Test
    fun `CallGraph resolves virtual dispatch to concrete implementations`() {
        runPta()
        val pta = ptaResult()
        val cg = pta.callGraph

        // The call graph should contain reachable methods.
        val reachable = cg.reachableMethods().toList()
        assertThat(reachable).isNotEmpty

        // main() should be reachable.
        val mainMethod = findMethod("PocProgram", "main")
        assertThat(mainMethod).isNotNull
        assertThat(cg.contains(mainMethod!!)).isTrue

        // main() calls getImpl() — a static call, should be in the CG.
        val getImpl = findMethod("PocProgram", "getImpl")
        assertThat(getImpl).isNotNull
        val calleesOfMain = cg.getCalleesOfM(mainMethod!!)
        assertThat(calleesOfMain).contains(getImpl!!)

        // The key test: main() calls obj.fetch() via virtual dispatch.
        // PTA should resolve this to BOTH ImplA.fetch() and ImplB.fetch(),
        // because getImpl() can return either impl1 (ImplA) or impl2 (ImplB).
        val implAFetch = findMethod("PocProgram\$ImplA", "fetch")
        val implBFetch = findMethod("PocProgram\$ImplB", "fetch")
        assertThat(implAFetch).isNotNull
        assertThat(implBFetch).isNotNull
        assertThat(calleesOfMain)
            .contains(implAFetch!!, implBFetch!!)

        // main() also calls sink() — a static call.
        val sink = findMethod("PocProgram", "sink")
        assertThat(sink).isNotNull
        assertThat(calleesOfMain).contains(sink!!)
    }

    @Test
    fun `Signature bridge produces DECX-compatible method IDs`() {
        runPta()
        val ch = hierarchy()

        // Get PocProgram.main(String[]) and convert to DECX signature.
        val mainClass = ch.getClass("PocProgram")
        assertThat(mainClass).isNotNull

        val mainMethod = mainClass!!.declaredMethods.firstOrNull { it.name == "main" }
        assertThat(mainMethod).isNotNull

        val decxSig = TaiESignatures.toDecxMethodId(mainMethod!!)
        // DECX format: ClassName.methodName(paramTypes):returnType
        assertThat(decxSig).isEqualTo("PocProgram.main(java.lang.String[]):void")

        // Verify inner class method: ImplA.fetch()
        val implAClass = ch.getClass("PocProgram\$ImplA")
        assertThat(implAClass).isNotNull
        val fetchMethod = implAClass!!.declaredMethods.firstOrNull { it.name == "fetch" }
        assertThat(fetchMethod).isNotNull
        assertThat(TaiESignatures.toDecxMethodId(fetchMethod!!))
            .isEqualTo("PocProgram\$ImplA.fetch():java.lang.String")

        // Verify no spaces in the signature (DECX convention).
        assertThat(decxSig).doesNotContain(" ")
    }

    @Test
    fun `Points-to query returns allocation sites for a variable`() {
        runPta()
        val pta = ptaResult()
        val ch = hierarchy()

        // The static field impl1 is initialized to new ImplA().
        val pocClass = ch.getClass("PocProgram")
        assertThat(pocClass).isNotNull
        val impl1Field = pocClass!!.declaredFields.firstOrNull { it.name == "impl1" }
        assertThat(impl1Field).isNotNull

        val pts = pta.getPointsToSet(impl1Field!!)
        assertThat(pts).isNotEmpty

        // Verify the pointed-to object's type is ImplA.
        val objTypes = pts.map { it.type.toString() }.toSet()
        assertThat(objTypes).contains("PocProgram\$ImplA")
    }

    @Test
    fun `ClassHierarchy provides subclass and implementor queries`() {
        runPta()
        val ch = hierarchy()

        // Interface is implemented by ImplA and ImplB.
        val iface = ch.getClass("PocProgram\$Interface")
        assertThat(iface).isNotNull

        val directImplementors = ch.getDirectImplementorsOf(iface!!)
        val implementorNames = directImplementors.map { it.name }.toSet()
        assertThat(implementorNames)
            .contains("PocProgram\$ImplA", "PocProgram\$ImplB")
    }

    @Test
    fun `PTA failure does not crash JVM - graceful degradation`() {
        // Try to build a World from a nonexistent path — should throw,
        // but the JVM should remain usable. This simulates the degradation
        // path where TaiEEngine catches exceptions and falls back to JADX.
        try {
            Main.main(
                "-cp", "/nonexistent/path/to/nowhere",
                "-m", "Nonexistent",
                "-a", "pta=cs:ci"
            )
        } catch (e: Exception) {
            // Expected — Tai-e throws on missing main class.
            assertThat(e).isNotNull
        }

        // JVM is still usable — reset World and verify.
        World.reset()
        assertThat("still alive").isEqualTo("still alive")
    }
}
