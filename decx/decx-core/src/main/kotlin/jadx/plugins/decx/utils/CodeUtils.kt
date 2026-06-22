package jadx.plugins.decx.utils

import jadx.api.JadxDecompiler
import jadx.api.JavaClass
import jadx.api.JavaField
import jadx.api.JavaMethod
import jadx.api.JavaNode
import jadx.core.dex.info.MethodInfo
import jadx.core.dex.instructions.args.ArgType
import jadx.core.dex.visitors.prepare.CollectConstValues
import java.util.ArrayList
import java.util.HashMap
import java.util.regex.Pattern

object CodeUtils {

    fun findMethod(decompiler: JadxDecompiler, mthSig: String): Pair<JavaClass, JavaMethod>? {
        val normalizedSig = normalizeSignature(mthSig)
        decompiler.classesWithInners?.forEach { clazz ->
            clazz.methods.find { methodSignature(it) == normalizedSig }?.let { method ->
                return clazz to method
            }
        }
        return null
    }

    fun findField(decompiler: JadxDecompiler, fldSig: String): Pair<JavaClass, JavaField>? {
        val normalizedSig = normalizeSignature(fldSig)
        decompiler.classesWithInners?.forEach { clazz ->
            clazz.fields.find { fieldSignature(it) == normalizedSig }?.let { field ->
                return clazz to field
            }
        }
        return null
    }

    fun methodSignature(mth: JavaMethod): String {
        return mth.toString().replace(" ", "")
    }

    fun methodSignature(mth: MethodInfo): String {
        return mth.toString().replace(" ", "")
    }

    fun fieldSignature(fld: JavaField): String {
        return fld.toString().replace(" ", "")
    }

    private fun normalizeSignature(signature: String): String {
        return signature.replace(" ", "")
    }

    // From jadx core - usage analysis
    fun buildUsageQuery(decompiler: JadxDecompiler, node: JavaNode): Map<JavaNode, List<JavaNode>> {
        node.declaringClass?.let { clazz ->
            val decision = DecompileGuard.decompile(clazz, DecompileGuard.Purpose.XREF)
            if (!decision.allowed) {
                return emptyMap()
            }
        }
        val map = HashMap<JavaNode, List<JavaNode>>()
        map[node] = node.useIn

        if (node is JavaClass) {
            node.methods.forEach { mth ->
                if (mth.isConstructor) {
                    map[mth] = mth.useIn
                }
            }
        } else if (node is JavaMethod) {
            node.overrideRelatedMethods.forEach { overrideMth ->
                map[overrideMth] = overrideMth.useIn
            }
        } else if (node is JavaField && decompiler.args.isReplaceConsts) {
            val fld = node.fieldNode
            val isPrivate = fld.accessFlags.isPrivate
            val constValue = CollectConstValues.getFieldConstValue(fld)
            val constField = constValue != null

            if (constField && !isPrivate) {
                // When constants are inlined, search all classes to collect usages
                // of replaced constant values throughout the codebase
                val allClasses = decompiler.classesWithInners ?: emptyList()
                map[node] = allClasses
            }
        }
        
        return map
    }

    fun extractMethodSmaliCode(clazz: JavaClass, mth: JavaMethod): String {
        val classSmaliCode = clazz.smali ?: throw IllegalStateException("Smali code not available for class: ${clazz.fullName}")

        try {
            val smaliSignature = buildSmaliSignature(mth)

            val patternString = "(^\\s*\\.method[^\n]*${Regex.escape(smaliSignature)}.*?^\\s*\\.end method)"
            val pattern = Pattern.compile(patternString, Pattern.DOTALL or Pattern.MULTILINE)
            val matcher = pattern.matcher(classSmaliCode)

            return if (matcher.find()) {
                matcher.group(1).trimIndent()
            } else {
                throw NoSuchMethodException("Smali method body not found for signature: $smaliSignature in class: ${clazz.fullName}")
            }
        } catch (e: Exception) {
            if (e is IllegalStateException || e is NoSuchMethodException) throw e
            throw RuntimeException("Error extracting Smali code for method ${mth.name} in class ${clazz.fullName}", e)
        }
    }

    fun getLineForPos(code: String, pos: Int): String {
        val start = getLineStartForPos(code, pos)
        val end = getLineEndForPos(code, pos)
        return code.substring(start, end)
    }

    fun getLineNumberForPos(code: String, pos: Int): Int {
        if (pos < 0 || pos >= code.length) {
            return 1
        }
        return code.substring(0, pos).count { it == '\n' } + 1
    }

    private fun getLineStartForPos(code: String, pos: Int): Int {
        val start = getNewLinePosBefore(code, pos)
        return if (start == -1) 0 else start + 1
    }

    private fun getLineEndForPos(code: String, pos: Int): Int {
        val end = getNewLinePosAfter(code, pos)
        return if (end == -1) code.length else end
    }

    private fun getNewLinePosAfter(code: String, startPos: Int): Int {
        val pos = code.indexOf('\n', startPos)
        if (pos != -1) {
            // check for '\r\n'
            val prev = pos - 1
            if (code[prev] == '\r') {
                return prev
            }
        }
        return pos
    }

    private fun getNewLinePosBefore(code: String, startPos: Int): Int {
        return code.lastIndexOf('\n', startPos)
    }

    private fun buildSmaliSignature(mth: JavaMethod): String {
        val methodName = mth.name
        val parameters = mth.arguments.joinToString("") {
            javaTypeToSmaliDescriptor(it)
        }
        val returnType = javaTypeToSmaliDescriptor(mth.returnType)

        val signature = "$methodName($parameters)$returnType"
        return signature
    }

    private fun javaTypeToSmaliDescriptor(type: ArgType): String {
        return when {
            type.isPrimitive -> when (type.primitiveType) {
                ArgType.BOOLEAN.primitiveType -> "Z"
                ArgType.BYTE.primitiveType -> "B"
                ArgType.SHORT.primitiveType -> "S"
                ArgType.CHAR.primitiveType -> "C"
                ArgType.INT.primitiveType -> "I"
                ArgType.LONG.primitiveType -> "J"
                ArgType.FLOAT.primitiveType -> "F"
                ArgType.DOUBLE.primitiveType -> "D"
                ArgType.VOID.primitiveType -> "V"
                else -> throw IllegalArgumentException("Unknown primitive type: ${type.primitiveType}")
            }
            type.isArray -> {
                val arrayElement = type.arrayElement
                    ?: throw IllegalArgumentException("Array type without element: $type")
                "[${javaTypeToSmaliDescriptor(arrayElement)}"
            }
            type.isObject -> "L${type.`object`.replace('.', '/')};"
            else -> throw IllegalArgumentException("Unknown ArgType: $type")
        }
    }
}
