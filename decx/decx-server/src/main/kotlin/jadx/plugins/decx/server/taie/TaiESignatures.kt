package jadx.plugins.decx.server.taie

import pascal.taie.language.classes.JField
import pascal.taie.language.classes.JMethod
import pascal.taie.language.type.Type

/**
 * Bridges Tai-e's signature format to DECX's canonical signature, so that
 * query results produced by Tai-e (callers, callees, points-to, etc.) can be
 * cross-referenced against DECX endpoints backed by JADX
 * (get_method_source, get_method_xref, search_method, ...).
 *
 * Tai-e method signature (StringReps.getSignatureOf):
 *   <Class: RetType name(ParamType1,ParamType2)>
 *
 * DECX method signature (CodeUtils.methodSignature = mth.toString().replace(" ", "")):
 *   Class.name(ParamType1,ParamType2):RetType
 *
 * Both use dotted fully-qualified class names, Java-source-style types
 * (int, java.lang.String, boolean[]), and `$` for inner classes.
 * The only difference is structural layout, so conversion is pure rearrangement.
 */
object TaiESignatures {

    /**
     * Converts a Tai-e [JMethod] to the canonical DECX method signature.
     *
     * Example:
     *   Tai-e: <com.example.Foo: boolean bar(int,java.lang.String)>
     *   DECX:  com.example.Foo.bar(int,java.lang.String):boolean
     */
    fun toDecxMethodId(method: JMethod): String {
        val cls = method.declaringClass.name
        val name = method.name
        val ret = method.returnType.toDecxType()
        val params = method.paramTypes.joinToString(",") { it.toDecxType() }
        return "$cls.$name($params):$ret"
    }

    /**
     * Converts a Tai-e [JField] to the canonical DECX field signature.
     *
     * Example:
     *   Tai-e: <com.example.Foo: java.lang.String TAG>
     *   DECX:  com.example.Foo.TAG:java.lang.String
     */
    fun toDecxFieldId(field: JField): String {
        val cls = field.declaringClass.name
        val name = field.name
        val type = field.type.toDecxType()
        return "$cls.$name:$type"
    }

    /**
     * Returns the DECX class name (dotted, `$` for inner classes) for a Tai-e [JMethod]'s
     * declaring class. This is just [pascal.taie.language.classes.JClass.getName],
     * exposed here for symmetry with the other converters.
     */
    fun toDecxClassName(method: JMethod): String = method.declaringClass.name

    /**
     * Normalizes a Tai-e [Type] to the DECX type string.
     *
     * Tai-e's [Type.toString] already uses Java-source style (int, java.lang.String,
     * java.lang.String[]), which matches DECX. We call toString() and strip any
     * incidental whitespace to match DECX's no-space convention.
     */
    private fun Type.toDecxType(): String = toString().replace(" ", "")
}
