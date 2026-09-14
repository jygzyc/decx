package jadx.plugins.decx.utils

import jadx.api.JadxArgs
import jadx.api.JadxDecompiler
import jadx.plugins.input.dex.DexInputPlugin
import jadx.plugins.input.smali.SmaliConvert
import jadx.plugins.input.smali.SmaliInputOptions
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * Integration test for the metadata-only hierarchy checks that replaced the
 * `clazz.smali.contains(".super …"/".implement …")` scans.
 *
 * Assembles a tiny smali project into dex data (via jadx-smali-input), loads it
 * with a real JADX decompiler (via jadx-dex-input), and asserts
 * [CodeUtils.extendsClass] / [CodeUtils.implementsInterface] match the actual
 * (direct) hierarchy — including the `$`-separated raw name of inner classes,
 * which the old smali-string matching got wrong for inner classes.
 */
class CodeUtilsHierarchyTest {

    @TempDir
    lateinit var tempDir: Path

    @Test
    fun extendsClassAndImplementsInterfaceMatchRealHierarchy() {
        val smaliFiles = writeSmaliFiles()
        // registerOptions() + setOptions(emptyMap()) applies the declared
        // defaults, most importantly api-level=27 (the raw field would be 0,
        // for which no dex opcodes are available and assembly fails).
        val options = SmaliInputOptions().apply {
            registerOptions()
            setOptions(emptyMap()) // applies defaults, e.g. api-level=27
            setThreads(1) // 0 threads would throw in SmaliConvert.compile
        }
        val convert = SmaliConvert()
        assertThat(convert.execute(smaliFiles, options))
            .`as`("smali assembly failed")
            .isTrue()

        val loader = DexInputPlugin().loadDexData(convert.getDexData())
        val decompiler = JadxDecompiler(JadxArgs().apply {
            setSkipResources(true)
            setThreadsCount(1)
        })
        decompiler.addCustomCodeLoader(loader)
        decompiler.load()

        val all = decompiler.classesWithInners
        assertThat(all.map { it.fullName }).containsExactlyInAnyOrder(
            "t.Base", "t.IFoo", "t.Child", "t.IOuter", "t.IOuter.Stub", "t.Impl", "t.Child2"
        )

        val base = all.single { it.fullName == "t.Base" }
        val ifoo = all.single { it.fullName == "t.IFoo" }
        val child = all.single { it.fullName == "t.Child" }
        val stub = all.single { it.fullName == "t.IOuter.Stub" }
        val impl = all.single { it.fullName == "t.Impl" }
        val child2 = all.single { it.fullName == "t.Child2" }

        // Top-level direct superclass.
        assertThat(CodeUtils.extendsClass(child, base.rawName)).isTrue()
        assertThat(CodeUtils.extendsClass(child, ifoo.rawName)).isFalse()

        // Direct interfaces only.
        assertThat(CodeUtils.implementsInterface(child, ifoo.rawName)).isTrue()
        assertThat(CodeUtils.implementsInterface(child, base.rawName)).isFalse()

        // Inner-class superclass: raw name uses '$' while fullName uses '.'.
        assertThat(stub.rawName).isEqualTo("t.IOuter\$Stub")
        assertThat(CodeUtils.extendsClass(impl, stub.rawName)).isTrue()

        // Only DIRECT superclass/interface counts — matches smali `.super`/`.implement`.
        assertThat(CodeUtils.extendsClass(child2, impl.rawName)).isTrue()
        assertThat(CodeUtils.extendsClass(child2, base.rawName)).isFalse()
        assertThat(CodeUtils.implementsInterface(child2, ifoo.rawName)).isFalse()
    }

    private fun writeSmaliFiles(): List<Path> {
        val smaliDir = tempDir.resolve("smali")
        val files = mapOf(
            "t/IFoo.smali" to """
                .class public interface abstract Lt/IFoo;
                .super Ljava/lang/Object;
            """.trimIndent(),
            "t/Base.smali" to """
                .class public Lt/Base;
                .super Ljava/lang/Object;
                .method public constructor <init>()V
                    .registers 1
                    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
                    return-void
                .end method
            """.trimIndent(),
            "t/Child.smali" to """
                .class public Lt/Child;
                .super Lt/Base;
                .implements Lt/IFoo;
                .method public constructor <init>()V
                    .registers 1
                    invoke-direct {p0}, Lt/Base;-><init>()V
                    return-void
                .end method
            """.trimIndent(),
            "t/IOuter.smali" to """
                .class public interface abstract Lt/IOuter;
                .super Ljava/lang/Object;
            """.trimIndent(),
            "t/IOuter\$Stub.smali" to """
                .class public Lt/IOuter${'$'}Stub;
                .super Ljava/lang/Object;
                .method public constructor <init>()V
                    .registers 1
                    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
                    return-void
                .end method
            """.trimIndent(),
            "t/Impl.smali" to """
                .class public Lt/Impl;
                .super Lt/IOuter${'$'}Stub;
                .method public constructor <init>()V
                    .registers 1
                    invoke-direct {p0}, Lt/IOuter${'$'}Stub;-><init>()V
                    return-void
                .end method
            """.trimIndent(),
            "t/Child2.smali" to """
                .class public Lt/Child2;
                .super Lt/Impl;
                .method public constructor <init>()V
                    .registers 1
                    invoke-direct {p0}, Lt/Impl;-><init>()V
                    return-void
                .end method
            """.trimIndent(),
        )
        return files.map { (rel, content) ->
            val f = smaliDir.resolve(rel)
            Files.createDirectories(f.parent)
            Files.writeString(f, content)
            f
        }
    }
}
