package jadx.plugins.decx.server.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import pascal.taie.language.classes.JClass
import pascal.taie.language.classes.JField
import pascal.taie.language.classes.JMethod
import pascal.taie.language.classes.JClassLoader
import pascal.taie.language.classes.Modifier
import pascal.taie.language.type.ArrayType
import pascal.taie.language.type.BooleanType
import pascal.taie.language.type.ClassType
import pascal.taie.language.type.IntType
import pascal.taie.language.type.VoidType

/**
 * Unit tests for [TaiESignatures] — the bridge between Tai-e's signature
 * format and DECX's canonical signature.
 *
 * These verify the core assumption of the whole integration: that Tai-e
 * results (produced as JMethod/JField) can be normalized to DECX signatures
 * that match what CodeUtils.findMethod / search_method return, so AI can
 * cross-reference Tai-e evidence with JADX source/xref endpoints.
 *
 * Tai-e method sig:  <com.example.Foo: boolean bar(int,java.lang.String)>
 * DECX method sig:   com.example.Foo.bar(int,java.lang.String):boolean
 */
class TaiESignaturesTest {

    /**
     * Minimal JClassLoader that does nothing — signature computation in
     * JMethod/JField constructors only reads name/types, never calls back
     * into the loader.
     */
    private val noopLoader = object : JClassLoader {
        override fun loadClass(name: String): JClass = throw UnsupportedOperationException("test loader")
        override fun getLoadedClasses(): Collection<JClass> = emptyList()
    }

    private fun jClass(name: String): JClass = JClass(noopLoader, name, null as String?)

    private fun classType(name: String): ClassType = ClassType(noopLoader, name)

    private fun arrayType(element: pascal.taie.language.type.Type): ArrayType =
        ArrayType(element, 1, element)

    private fun jMethod(
        cls: JClass, name: String,
        paramTypes: List<pascal.taie.language.type.Type>,
        returnType: pascal.taie.language.type.Type
    ): JMethod = JMethod(
        cls, name, emptySet<Modifier>(), paramTypes, returnType,
        emptyList(), null, null, null, null, null
    )

    private fun jField(
        cls: JClass, name: String, type: pascal.taie.language.type.Type
    ): JField = JField(cls, name, emptySet<Modifier>(), type, null, null)

    @Test
    fun `simple method with primitive param and return`() {
        val cls = jClass("com.example.Foo")
        val m = jMethod(cls, "bar", listOf(IntType.INT), BooleanType.BOOLEAN)
        // Tai-e sig: <com.example.Foo: boolean bar(int)>
        // DECX sig:  com.example.Foo.bar(int):boolean
        assertThat(TaiESignatures.toDecxMethodId(m))
            .isEqualTo("com.example.Foo.bar(int):boolean")
    }

    @Test
    fun `method with reference type param`() {
        val cls = jClass("com.example.MainActivity")
        val stringType = classType("java.lang.String")
        val m = jMethod(cls, "onCreate", listOf(stringType), VoidType.VOID)
        // Tai-e sig: <com.example.MainActivity: void onCreate(java.lang.String)>
        // DECX sig:  com.example.MainActivity.onCreate(java.lang.String):void
        assertThat(TaiESignatures.toDecxMethodId(m))
            .isEqualTo("com.example.MainActivity.onCreate(java.lang.String):void")
    }

    @Test
    fun `method with multiple params`() {
        val cls = jClass("com.example.Util")
        val m = jMethod(
            cls, "copy",
            listOf(arrayType(classType("java.lang.Byte")), IntType.INT),
            arrayType(classType("java.lang.String"))
        )
        // Tai-e sig: <com.example.Util: java.lang.String[] copy(java.lang.Byte[],int)>
        // DECX sig:  com.example.Util.copy(java.lang.Byte[],int):java.lang.String[]
        assertThat(TaiESignatures.toDecxMethodId(m))
            .isEqualTo("com.example.Util.copy(java.lang.Byte[],int):java.lang.String[]")
    }

    @Test
    fun `constructor keeps init name`() {
        val cls = jClass("com.example.Service")
        val m = jMethod(cls, "<init>", listOf(classType("java.lang.String")), VoidType.VOID)
        assertThat(TaiESignatures.toDecxMethodId(m))
            .isEqualTo("com.example.Service.<init>(java.lang.String):void")
    }

    @Test
    fun `inner class method uses dollar separator`() {
        val cls = jClass("com.example.Outer\$Inner")
        val m = jMethod(cls, "run", emptyList(), VoidType.VOID)
        assertThat(TaiESignatures.toDecxMethodId(m))
            .isEqualTo("com.example.Outer\$Inner.run():void")
    }

    @Test
    fun `no-arg method`() {
        val cls = jClass("com.example.Foo")
        val m = jMethod(cls, "toString", emptyList(), classType("java.lang.String"))
        assertThat(TaiESignatures.toDecxMethodId(m))
            .isEqualTo("com.example.Foo.toString():java.lang.String")
    }

    @Test
    fun `simple field`() {
        val cls = jClass("com.example.Foo")
        val f = jField(cls, "TAG", classType("java.lang.String"))
        // Tai-e sig: <com.example.Foo: java.lang.String TAG>
        // DECX sig:  com.example.Foo.TAG:java.lang.String
        assertThat(TaiESignatures.toDecxFieldId(f))
            .isEqualTo("com.example.Foo.TAG:java.lang.String")
    }

    @Test
    fun `primitive field`() {
        val cls = jClass("com.example.Foo")
        val f = jField(cls, "count", IntType.INT)
        assertThat(TaiESignatures.toDecxFieldId(f))
            .isEqualTo("com.example.Foo.count:int")
    }

    @Test
    fun `array field`() {
        val cls = jClass("com.example.Foo")
        val f = jField(cls, "items", arrayType(classType("java.lang.String")))
        assertThat(TaiESignatures.toDecxFieldId(f))
            .isEqualTo("com.example.Foo.items:java.lang.String[]")
    }

    @Test
    fun `class name extraction from method`() {
        val cls = jClass("com.example.Bar\$Baz")
        val m = jMethod(cls, "doSomething", emptyList(), VoidType.VOID)
        assertThat(TaiESignatures.toDecxClassName(m))
            .isEqualTo("com.example.Bar\$Baz")
    }
}
