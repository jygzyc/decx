package jadx.plugins.decx.service

import jadx.api.JadxDecompiler
import jadx.api.JavaNode
import jadx.core.dex.instructions.BaseInvokeNode
import jadx.core.dex.instructions.InvokeNode
import jadx.core.dex.nodes.MethodNode
import jadx.core.dex.visitors.DotGraphVisitor
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxFilter
import jadx.plugins.decx.api.DecxKind
import jadx.plugins.decx.api.DecxError
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.CodeUtils
import jadx.plugins.decx.utils.DecompileGuard
import jadx.plugins.decx.utils.ItemKind
import java.nio.file.Files

class ContextService(
    override val decompiler: JadxDecompiler,
    private val taiEEngine: ITaiEEngine? = null
) : DecompilerBackedService {

    private data class CalleeSummary(
        val signature: String,
        val owner: String,
        var callCount: Int = 0,
        val invokeTypes: MutableSet<String> = linkedSetOf(),
        var insnStr: String? = null
    )

    private fun processUsage(searchNode: JavaNode, xrefNodes: MutableList<JavaNode>): List<Map<String, Any>> {
        val items = mutableListOf<Map<String, Any>>()
        xrefNodes.groupBy(JavaNode::getTopParentClass).forEach classLoop@{ (topUseClass, nodesInClass) ->
            val codeInfo = topUseClass.codeInfo
            val usePositions = topUseClass.getUsePlacesFor(codeInfo, searchNode)
            if (usePositions.isEmpty()) {
                return@classLoop
            }
            val code = codeInfo.codeStr
            usePositions.forEach positionLoop@{ pos ->
                val line = CodeUtils.getLineForPos(code, pos)
                if (line.trim().startsWith("import ")) {
                    return@positionLoop
                }
                val correspondingNode = nodesInClass.firstOrNull() ?: nodesInClass.first()
                val codeLineNumber = CodeUtils.getLineNumberForPos(code, pos)
                items.add(
                    AnalysisResultUtils.item(
                        id = "${correspondingNode.fullName}#$codeLineNumber",
                        kind = ItemKind.XREF,
                        title = "Caller: ${correspondingNode.fullName}",
                        content = line.trim(),
                        meta = mapOf(
                            "owner" to topUseClass.fullName,
                            "member" to correspondingNode.fullName,
                            "line" to codeLineNumber
                        )
                    )
                )
            }
        }
        return items
    }

    private fun collectCalleeItems(mth: String, methodNode: MethodNode): List<Map<String, Any>> {
        try {
            methodNode.load()
        } catch (_: Exception) {
            return emptyList()
        }
        val insnArr = methodNode.instructions ?: return emptyList()
        val callees = linkedMapOf<String, CalleeSummary>()
        for (insn in insnArr) {
            if (insn == null) continue
            insn.visitInsns { currentInsn ->
                if (currentInsn is BaseInvokeNode) {
                    try {
                        val callMth = currentInsn.callMth
                        val signature = CodeUtils.methodSignature(callMth)
                        val insnStr = currentInsn.toString()
                        val callee = callees.getOrPut(signature) {
                            CalleeSummary(signature, callMth.declClass.fullName)
                        }
                        callee.callCount += 1
                        callee.invokeTypes.add((currentInsn as? InvokeNode)?.invokeType?.toString() ?: currentInsn.javaClass.simpleName)
                        if (callee.insnStr == null) callee.insnStr = insnStr
                    } catch (_: Exception) {
                        // skip unresolvable invoke
                    }
                }
            }
        }
        return callees.entries.mapIndexed { index, entry ->
            val callee = entry.value
            AnalysisResultUtils.item(
                id = "$mth#callee-$index",
                kind = ItemKind.XREF,
                title = "Callee: ${entry.key}",
                content = callee.insnStr ?: entry.key,
                meta = mapOf(
                    "owner" to callee.owner,
                    "call_count" to callee.callCount,
                    "invoke_types" to callee.invokeTypes.toList()
                )
            )
        }
    }

    private fun dumpCfgDot(methodNode: MethodNode): String {
        val tempDir = Files.createTempDirectory("decx-cfg-").toFile()
        return try {
            DotGraphVisitor.dump().save(tempDir, methodNode)
            val paths = Files.walk(tempDir.toPath())
            try {
                val dotPath = paths
                    .filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".dot") }
                    .findFirst()
                    .orElse(null)
                if (dotPath == null) "digraph { }" else String(Files.readAllBytes(dotPath))
            } finally {
                paths.close()
            }
        } finally {
            tempDir.deleteRecursively()
        }
    }

    /** Returns class-level context, including the class symbol and its members. */
    fun handleGetClassContext(cls: String): DecxApiResult {
        val query = mapOf("target" to cls)
        return try {
            val clazz = decompiler.searchJavaClassOrItsParentByOrigFullName(cls)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.CLASS_CONTEXT, query, DecxError.CLASS_NOT_FOUND, cls))
            val methodItems = clazz.methods.map { method ->
                val signature = CodeUtils.methodSignature(method)
                AnalysisResultUtils.item(
                    id = signature,
                    kind = ItemKind.SYMBOL,
                    title = "Method: $signature",
                    content = signature
                )
            }
            val fieldItems = clazz.fields.map { field ->
                val signature = CodeUtils.fieldSignature(field)
                AnalysisResultUtils.item(
                    id = signature,
                    kind = ItemKind.SYMBOL,
                    title = "Field: $signature",
                    content = signature
                )
            }
            val items = listOf(
                AnalysisResultUtils.item(
                    id = cls,
                    kind = ItemKind.SYMBOL,
                    title = "Class: ${cls.substringAfterLast('.')}",
                    content = cls,
                    meta = mapOf(
                        "method_count" to methodItems.size,
                        "field_count" to fieldItems.size
                    )
                )
            ) + methodItems + fieldItems
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.CLASS_CONTEXT, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.CLASS_CONTEXT, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Returns class source in Java or smali form. */
    fun handleGetClassSource(cls: String, smali: Boolean, filter: DecxFilter): DecxApiResult {
        val query = mapOf("target" to cls, "smali" to smali) + filter.toQuery()
        return try {
            // Exact fullName match first; fall back to JADX's tolerant search for inner classes
            // where the caller may have used '$' or '.' interchangeably.
            val clazz = decompiler.classesWithInners.find { it.fullName == cls }
                ?: decompiler.searchJavaClassOrItsParentByOrigFullName(cls)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.CLASS_SOURCE, query, DecxError.CLASS_NOT_FOUND, cls))

            // Determine the source code: try the requested format first, fall back to smali
            // when Java decompilation fails or produces empty output (e.g. for interfaces,
            // abstract stubs, or classes with JADX-internal decompile errors).
            val triedSmaliFallback: Boolean
            val code: String?
            if (smali) {
                code = safeSource { clazz.smali }
                triedSmaliFallback = false
            } else {
                val javaCode = safeSource { clazz.code }
                if (!javaCode.isNullOrBlank()) {
                    code = javaCode
                    triedSmaliFallback = false
                } else {
                    val smaliCode = safeSource { clazz.smali }
                    code = smaliCode
                    triedSmaliFallback = !smaliCode.isNullOrBlank()
                }
            }
            if (code.isNullOrBlank()) {
                return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.CLASS_SOURCE, query, DecxError.DECOMPILATION_SKIPPED, "decompiled to empty source: $cls")
                )
            }
            val actualSmali = smali || triedSmaliFallback
            val lines = code.lines()
            val returnedLineCount = filter.limit?.coerceAtMost(lines.size) ?: lines.size
            val limitedCode = filter.limit?.let { limit ->
                lines.take(limit).joinToString("\n")
            } ?: code
            val items = listOf(
                AnalysisResultUtils.item(
                    id = cls,
                    kind = ItemKind.CODE,
                    title = cls,
                    content = limitedCode,
                    meta = linkedMapOf(
                        "language" to if (actualSmali) "smali" else "java",
                        "total_lines" to lines.size,
                        "returned_lines" to returnedLineCount
                    ).apply {
                        if (triedSmaliFallback) put("smali_fallback", true)
                    }
                )
            )
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.CLASS_SOURCE, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.CLASS_SOURCE, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    private fun safeSource(getter: () -> String?): String? {
        return try {
            getter().takeIf { it.isNullOrBlank().not() }
        } catch (_: Exception) {
            null
        }
    }

    /** Returns method signature with caller and callee relationships. */
    fun handleGetMethodContext(mth: String): DecxApiResult {
        val query = mapOf("target" to mth)
        return try {
            val mthPair = CodeUtils.findMethod(decompiler, mth)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.METHOD_CONTEXT, query, DecxError.METHOD_NOT_FOUND, mth))
            val jcls = mthPair.first
            val jmth = mthPair.second
            val signature = CodeUtils.methodSignature(jmth)
            val decision = DecompileGuard.decompile(jcls, DecompileGuard.Purpose.XREF)
            if (!decision.allowed) {
                return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.METHOD_CONTEXT, query, DecxError.DECOMPILATION_SKIPPED, decision.messageFor(jcls.fullName))
                )
            }
            // Tier 1: Tai-e callers (if available)
            val taiECallers = taiEEngine?.takeIf { it.isReady }?.callersOf(signature)
            val callerItems: List<Map<String, Any>> = if (!taiECallers.isNullOrEmpty()) {
                taiECallers.map { edge ->
                    AnalysisResultUtils.item(
                        id = "${edge.from}#${edge.line ?: 0}",
                        kind = ItemKind.XREF,
                        title = "Caller: ${edge.from}",
                        content = edge.from,
                        meta = linkedMapOf(
                            "owner" to edge.from.substringBeforeLast('.', edge.from),
                            "member" to edge.from,
                            "line" to (edge.line ?: 0),
                            "invoke_type" to edge.invokeType,
                            "source" to "taie"
                        )
                    )
                }
            } else {
                val xrefMap = CodeUtils.buildUsageQuery(decompiler, jmth)
                processUsage(jmth, xrefMap.values.flatten().toMutableList())
            }
            // Tier 1: Tai-e callees (if available, dispatch-resolved)
            val taiECallees = taiEEngine?.takeIf { it.isReady }?.calleesOf(signature)
            val calleeItems: List<Map<String, Any>> = if (!taiECallees.isNullOrEmpty()) {
                taiECallees.mapIndexed { index, edge ->
                    AnalysisResultUtils.item(
                        id = "$signature#callee-$index",
                        kind = ItemKind.XREF,
                        title = "Callee: ${edge.to}",
                        content = edge.to,
                        meta = linkedMapOf(
                            "owner" to edge.to.substringBeforeLast('.', edge.to),
                            "invoke_type" to edge.invokeType,
                            "source" to "taie"
                        )
                    )
                }
            } else {
                collectCalleeItems(signature, jmth.methodNode)
            }
            val signatureItem = AnalysisResultUtils.item(
                id = signature,
                kind = ItemKind.SYMBOL,
                title = "Method signature: $signature",
                content = signature,
                meta = mapOf(
                    "owner" to jcls.fullName,
                    "return_type" to jmth.returnType.toString(),
                    "argument_count" to jmth.arguments.size,
                    "caller_count" to callerItems.size,
                    "callee_count" to calleeItems.size
                )
            )
            val items = listOf(signatureItem) + callerItems + calleeItems
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.METHOD_CONTEXT, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.METHOD_CONTEXT, query, DecxError.SERVER_INTERNAL_ERROR, "${e.javaClass.simpleName}: ${e.message}"))
        }
    }

    /** Returns a DOT control-flow graph built from JADX basic blocks. */
    fun handleGetMethodCfg(mth: String): DecxApiResult {
        val query = mapOf("target" to mth)
        return try {
            val mthPair = CodeUtils.findMethod(decompiler, mth)
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.METHOD_CFG, query, DecxError.METHOD_NOT_FOUND, mth))
            val jmth = mthPair.second
            val methodNode = jmth.methodNode
            methodNode.load()
            val dot = dumpCfgDot(methodNode)
            val signature = CodeUtils.methodSignature(jmth)
            val item = AnalysisResultUtils.item(
                id = "$signature#cfg-dot",
                kind = ItemKind.CODE,
                title = "CFG DOT: $signature",
                content = dot,
                meta = mapOf("language" to "dot")
            )
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.METHOD_CFG, query, listOf(item)))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.METHOD_CFG, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Returns call sites that reference the requested method. */
    fun handleGetMethodXref(mth: String): DecxApiResult {
        val query = mapOf("target" to mth)
        return try {
            // Tier 1: try Tai-e call-graph callers (dispatch-resolved, whole-program)
            val taiEItems = taiEEngine?.takeIf { it.isReady }?.let { engine ->
                val callers = engine.callersOf(mth)
                if (callers.isNotEmpty()) {
                    callers.map { edge ->
                        AnalysisResultUtils.item(
                            id = "${edge.from}#${edge.line ?: 0}",
                            kind = ItemKind.XREF,
                            title = "Caller: ${edge.from}",
                            content = edge.from,
                            meta = linkedMapOf(
                                "owner" to edge.from.substringBeforeLast('.', edge.from),
                                "member" to edge.from,
                                "line" to (edge.line ?: 0),
                                "invoke_type" to edge.invokeType,
                                "source" to "taie"
                            )
                        )
                    }
                } else null
            }
            if (taiEItems != null) {
                return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.METHOD_XREF, query, taiEItems))
            }
            // Fallback: JADX useIn-based reverse lookup
            val mthPair = CodeUtils.findMethod(decompiler, mth)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.METHOD_XREF, query, DecxError.METHOD_NOT_FOUND, mth))
            val jcls = mthPair.first
            val jmth = mthPair.second
            val decision = DecompileGuard.decompile(jcls, DecompileGuard.Purpose.XREF)
            if (!decision.allowed) {
                return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.METHOD_XREF, query, DecxError.DECOMPILATION_SKIPPED, decision.messageFor(jcls.fullName))
                )
            }
            val xrefMap = CodeUtils.buildUsageQuery(decompiler, jmth)
            val xrefNodes = xrefMap.values.flatten().toMutableList()
            val items = processUsage(jmth, xrefNodes)
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.METHOD_XREF, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.METHOD_XREF, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Returns usage sites that reference the requested field. */
    fun handleGetFieldXref(fld: String): DecxApiResult {
        val query = mapOf("target" to fld)
        return try {
            val fldPair = CodeUtils.findField(decompiler, fld)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.FIELD_XREF, query, DecxError.FIELD_NOT_FOUND, fld))
            val jcls = fldPair.first
            val jfld = fldPair.second
            val decision = DecompileGuard.decompile(jcls, DecompileGuard.Purpose.XREF)
            if (!decision.allowed) {
                return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.FIELD_XREF, query, DecxError.DECOMPILATION_SKIPPED, decision.messageFor(jcls.fullName))
                )
            }
            val xrefMap = CodeUtils.buildUsageQuery(decompiler, jfld)
            val xrefNodes = xrefMap.values.flatten().toMutableList()
            val items = processUsage(jfld, xrefNodes)
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.FIELD_XREF, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.FIELD_XREF, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Returns usage sites that reference the requested class symbol. */
    fun handleGetClassXref(cls: String): DecxApiResult {
        val query = mapOf("target" to cls)
        return try {
            val jclazz = decompiler.searchJavaClassOrItsParentByOrigFullName(cls)
                ?: return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.CLASS_XREF, query, DecxError.CLASS_NOT_FOUND, cls))
            val decision = DecompileGuard.decompile(jclazz, DecompileGuard.Purpose.XREF)
            if (!decision.allowed) {
                return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.CLASS_XREF, query, DecxError.DECOMPILATION_SKIPPED, decision.messageFor(jclazz.fullName))
                )
            }
            val xrefMap = CodeUtils.buildUsageQuery(decompiler, jclazz)
            val xrefNodes = xrefMap.values.flatten().toMutableList()
            val items = processUsage(jclazz, xrefNodes)
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.CLASS_XREF, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.CLASS_XREF, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Lists implementors of the requested interface (transitive when Tai-e is available). */
    fun handleGetImplementOfInterface(iface: String): DecxApiResult {
        val query = mapOf("target" to iface)
        return try {
            // Tier 1: Tai-e class hierarchy (transitive, no smali text scan)
            val taiEItems = taiEEngine?.takeIf { it.isReady }?.let { engine ->
                val impls = engine.implementorsOf(iface, transitive = true)
                if (impls.isNotEmpty()) {
                    impls.map { implName ->
                        AnalysisResultUtils.item(
                            id = implName,
                            kind = ItemKind.SYMBOL,
                            title = "Implementation: ${implName.substringAfterLast('.')}",
                            content = "$implName implements $iface",
                            meta = linkedMapOf("interface" to iface, "source" to "taie")
                        )
                    }
                } else null
            }
            if (taiEItems != null) {
                return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.IMPLEMENTATIONS, query, taiEItems))
            }
            // Fallback: smali text scan (direct implementors only)
            val interfaceClazz = decompiler.searchJavaClassOrItsParentByOrigFullName(iface)
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.IMPLEMENTATIONS, query, DecxError.INTERFACE_NOT_FOUND, iface))
            val implementingClasses = decompiler.classesWithInners.filter {
                it.smali.contains(".implement L${interfaceClazz.fullName.replace('.', '/')};")
            }
            val items = implementingClasses.map { clazz ->
                AnalysisResultUtils.item(
                    id = clazz.fullName,
                    kind = ItemKind.SYMBOL,
                    title = "Implementation: ${clazz.fullName.substringAfterLast('.')}",
                    content = "${clazz.fullName} implements $iface",
                    meta = mapOf("interface" to iface)
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.IMPLEMENTATIONS, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.IMPLEMENTATIONS, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Lists subclasses of the requested class (transitive when Tai-e is available). */
    fun handleGetSubclasses(cls: String): DecxApiResult {
        val query = mapOf("target" to cls)
        return try {
            // Tier 1: Tai-e class hierarchy (transitive, no smali text scan)
            val taiEItems = taiEEngine?.takeIf { it.isReady }?.let { engine ->
                val subs = engine.subclassesOf(cls, transitive = true)
                if (subs.isNotEmpty()) {
                    subs.map { subName ->
                        AnalysisResultUtils.item(
                            id = subName,
                            kind = ItemKind.SYMBOL,
                            title = "Subclass: ${subName.substringAfterLast('.')}",
                            content = "$subName extends $cls",
                            meta = linkedMapOf("superclass" to cls, "source" to "taie")
                        )
                    }
                } else null
            }
            if (taiEItems != null) {
                return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SUB_CLASSES, query, taiEItems))
            }
            // Fallback: smali text scan (direct subclasses only)
            val clazz = decompiler.searchJavaClassOrItsParentByOrigFullName(cls)
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SUB_CLASSES, query, DecxError.CLASS_NOT_FOUND, cls))
            val subClasses = decompiler.classesWithInners.filter {
                it.smali.contains(".super L${clazz.fullName.replace(".", "/")};")
            }
            val items = subClasses.map { sub ->
                AnalysisResultUtils.item(
                    id = sub.fullName,
                    kind = ItemKind.SYMBOL,
                    title = "Subclass: ${sub.fullName.substringAfterLast('.')}",
                    content = "${sub.fullName} extends $cls",
                    meta = mapOf("superclass" to cls)
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SUB_CLASSES, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SUB_CLASSES, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }
}
