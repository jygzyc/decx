package jadx.plugins.decx.utils

import jadx.api.JadxArgs
import jadx.api.JadxDecompiler
import jadx.api.JavaClass
import jadx.plugins.decx.api.DecxApiImpl
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxFilter
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File

/**
 * Real-fixture integration test: loads the actual `decx-cli/tests/fixtures/sieve.apk`
 * with the same code-cache wiring the standalone server uses, then verifies the
 * service-layer refactor against real (obfuscated-adjacent, library-heavy) data.
 *
 * The core check is an **equivalence** proof: for a real base class / interface,
 * the new metadata checks (`extendsClass` / `implementsInterface`) must return the
 * exact same direct-member set as the old smali-text scan (`.super L…;` /
 * `.implement L…;`).
 */
class DecxFixtureIntegrationTest {

    private val apk: File = locateFixture()

    @Test
    fun serviceHierarchyAndScansOnRealApk() {
        assumeTrue(apk.isFile, "fixture sieve.apk not found")

        // Same wiring as DecxServerApp.main: bounded code cache + unload worker.
        DecompileGuard.reset()
        val args = JadxArgs().apply {
            setInputFiles(listOf(apk))
            setSkipResources(false) // real app: keep resources for dynamic receivers
            setThreadsCount(4)
        }
        DecompileGuard.installBoundedCodeCache(args)
        val decompiler = JadxDecompiler(args)
        DecompileGuard.attach(decompiler)
        decompiler.load()

        val all = decompiler.classesWithInners
        assertThat(all).isNotEmpty
        val api = DecxApiImpl(decompiler)

        // Restrict candidates to the app's own package so the smali comparison
        // stays fast (rendering smali for every bundled library class is slow).
        val candidates = all.filter { it.fullName.startsWith("com.withsecure.example.sieve") }
        assertThat(candidates).isNotEmpty

        verifySubclassEquivalence(candidates)
        verifyInterfaceEquivalence(candidates)
        verifyNestedAttribution(candidates)
        exerciseScans(api, all)

        // Code cache must be present and bounded by the configured cap.
        val cacheStats = DecompileGuard.stats()["code_cache"] as Map<*, *>
        assertThat(cacheStats["max_bytes"] as Long).isGreaterThan(0)
    }

    /** New `extendsClass` vs old `.super L…;` smali scan must agree on real data. */
    private fun verifySubclassEquivalence(candidates: List<JavaClass>) {
        // The most common direct superclass among the app classes (usually a base
        // Activity/service base or a library base like AppCompatActivity).
        val baseRawName = candidates
            .mapNotNull { it.classNode.superClass?.getObject() }
            .filter { it != "java.lang.Object" }
            .groupingBy { it }.eachCount()
            .maxByOrNull { it.value }?.key
        assumeTrue(baseRawName != null, "no common superclass found in app package")
        val base = baseRawName!!
        val smaliSuper = ".super L${base.replace('.', '/')};"

        // Only compare over classes whose smali cannot be polluted by nested
        // classes: `clazz.smali` concatenates inner AND inlined classes
        // (e.g. `Foo$$ExternalSyntheticLambda*` shows up inside `Foo.smali`),
        // so a substring scan would wrongly credit the outer class with the
        // nested class's `.implements`/`.super` declarations.
        val comparable = candidates.filter {
            it.classNode.innerClasses.isEmpty() && it.classNode.inlinedClasses.isEmpty()
        }

        val newSet = comparable.filter { CodeUtils.extendsClass(it, base) }.map { it.fullName }.toSet()
        val oldSet = comparable.filter { it.smali.contains(smaliSuper) }.map { it.fullName }.toSet()

        assertThat(newSet)
            .`as`("extendsClass mismatch vs smali .super for base %s", base)
            .isEqualTo(oldSet)
        assertThat(newSet).isNotEmpty // sanity: the chosen base actually has subclasses
    }

    /**
     * New `implementsInterface` vs baksmali `.implements L…;` scan must agree
     * on DIRECT declarations of the class itself.
     *
     * Two pre-refactor defects are pinned down by this test:
     *  1. the old code searched `.implement L…;` (no trailing "s"), which
     *     never matches baksmali's `.implements` directive → always empty;
     *  2. a corrected `.implements` substring scan is still wrong, because
     *     `clazz.smali` concatenates inner/anonymous class smali into the
     *     outer class text, so an anonymous `OnClickListener` would falsely
     *     report the OUTER class as implementor. The metadata check matches
     *     the dex `interfaces` list exactly (verified: clsData.interfacesTypes
     *     is empty for outer classes whose anonymous inners implement it).
     *
     * Hence the ground truth here is: direct dex interface declarations,
     * compared only over classes whose smali cannot be polluted by nested
     * classes (top-level synthetic lambdas + classes without inners).
     */
    private fun verifyInterfaceEquivalence(candidates: List<JavaClass>) {
        val ifaceRawName = candidates
            .flatMap { cls -> cls.classNode.interfaces.map { it.getObject() } }
            .groupingBy { it }.eachCount()
            .filterValues { it > 0 }.keys
            .firstOrNull()
        assumeTrue(ifaceRawName != null, "no implemented interface found in app package")
        val iface = ifaceRawName!!
        val smaliImpl = ".implements L${iface.replace('.', '/')};"

        // Only compare over classes whose smali cannot be polluted by nested
        // classes (see verifySubclassEquivalence for why).
        val comparable = candidates.filter {
            it.classNode.innerClasses.isEmpty() && it.classNode.inlinedClasses.isEmpty()
        }

        val newSet = comparable.filter { CodeUtils.implementsInterface(it, iface) }.map { it.fullName }.toSet()
        val oldSet = comparable.filter { it.smali.contains(smaliImpl) }.map { it.fullName }.toSet()

        assertThat(newSet)
            .`as`("implementsInterface mismatch vs smali .implements for interface %s", iface)
            .isEqualTo(oldSet)
        assertThat(newSet).isNotEmpty // sanity: the chosen interface actually has implementors
    }

    /**
     * Nested-class attribution: an inlined lambda implementing an interface
     * must make the OUTER class match too — this is what lets
     * "which class handles onClick" queries return `SomeActivity` instead of
     * only the compiler-generated `SomeActivity$$ExternalSyntheticLambda*`.
     */
    private fun verifyNestedAttribution(candidates: List<JavaClass>) {
        val attributed = candidates.firstOrNull { outer ->
            outer.classNode.interfaces.isEmpty() &&
                outer.classNode.inlinedClasses.any { it.interfaces.isNotEmpty() }
        } ?: return assumeTrue(false, "no inlined implementor in app package")
        val innerIface = attributed.classNode.inlinedClasses
            .first { it.interfaces.isNotEmpty() }
            .interfaces.first().getObject()

        assertThat(CodeUtils.implementsInterface(attributed, innerIface))
            .`as`("outer class should match via inlined implementor: %s", attributed.fullName)
            .isTrue()
    }

    /** Exercise the refactored scan endpoints through the real service layer. */
    private fun exerciseScans(api: DecxApiImpl, all: List<JavaClass>) {
        // get_dynamic_receivers over the app package (used to render full smali per class).
        val receivers = api.getDynamicReceivers(DecxFilter(includes = listOf("com.withsecure.example.sieve")))
        assertThat(receivers.success).`as`("dynamic receivers: ${receivers.data}").isTrue()

        // get_aidl_interfaces — sieve has no AIDL; must fail gracefully, not crash.
        val aidl = api.getAidlInterfaces(DecxFilter(includes = listOf("com.withsecure.example.sieve")))
        assertThat(aidl.data).isNotEmpty() // envelope always present regardless of success flag

        // Discover real in-dex hierarchy pairs so the endpoint assertions do not
        // depend on assumptions about the app's framework usage.
        val byRawName = all.associateBy { it.rawName }

        val superPair = all.asSequence()
            .mapNotNull { c -> c.classNode.superClass?.getObject()?.let { it to c } }
            .firstOrNull { (parent, _) -> byRawName.containsKey(parent) }
        if (superPair != null) {
            val (parentRaw, child) = superPair
            val subs = api.getSubclasses(byRawName[parentRaw]!!.fullName)
            assertThat(subs.success).`as`("getSubclasses: ${subs.data}").isTrue()
            assertThat(ids(subs)).contains(child.fullName)
        }

        val ifacePair = all.asSequence()
            .flatMap { c -> c.classNode.interfaces.map { it.getObject() to c } }
            .firstOrNull { (iface, _) -> byRawName.containsKey(iface) }
        if (ifacePair != null) {
            val (ifaceRaw, implCls) = ifacePair
            val impls = api.getImplementations(byRawName[ifaceRaw]!!.fullName)
            assertThat(impls.success).`as`("getImplementations: ${impls.data}").isTrue()
            assertThat(ids(impls)).contains(implCls.fullName)
        }

        // A bounded global search exercises the bounded code cache path end to end.
        val search = api.searchGlobalKey("onCreate", DecxFilter(includes = listOf("com.withsecure.example.sieve")))
        assertThat(search.success).`as`("searchGlobalKey: ${search.data}").isTrue()
        assertThat(ids(search)).isNotEmpty()
    }

    private fun ids(result: DecxApiResult): List<String> =
        (result.data["items"] as? List<*>)?.mapNotNull { (it as? Map<*, *>)?.get("id") as? String } ?: emptyList()

    private fun locateFixture(): File {
        val candidates = listOf(
            "../../decx-cli/tests/fixtures/sieve.apk",
            "../decx-cli/tests/fixtures/sieve.apk",
            "../../../decx-cli/tests/fixtures/sieve.apk",
            "decx-cli/tests/fixtures/sieve.apk",
        )
        val wd = File(System.getProperty("user.dir")).canonicalFile
        for (rel in candidates) {
            val f = File(wd, rel).canonicalFile
            if (f.isFile) return f
        }
        return File(candidates[0])
    }
}
