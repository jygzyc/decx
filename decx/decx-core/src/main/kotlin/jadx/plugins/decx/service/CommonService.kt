package jadx.plugins.decx.service

import jadx.api.JadxDecompiler
import jadx.plugins.decx.api.DecxKind
import jadx.plugins.decx.api.DecxFilter
import jadx.plugins.decx.model.DecxError
import jadx.plugins.decx.model.DecxServiceInterface
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.CodeUtils
import jadx.plugins.decx.utils.ItemKind
import java.util.regex.PatternSyntaxException

class CommonService(override val decompiler: JadxDecompiler) : DecxServiceInterface {

    /** Returns the complete class inventory for the opened artifact. */
    fun handleGetClasses(filter: DecxFilter): DecxApiResult {
        val query = filter.toQuery()
        return try {
            val compiled = filter.compile()
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.CLASSES, query, DecxError.INVALID_PARAMETER, "invalid filter regex"))
            val classes = decompiler.classesWithInners
                .map { it.fullName }
                .filter { className -> compiled.matches(className) }
                .let { classNames -> filter.limit(classNames) }
            val items = classes.map { cls ->
                AnalysisResultUtils.item(
                    id = cls,
                    kind = ItemKind.SYMBOL,
                    title = "Class: ${cls.substringAfterLast('.')}",
                    content = cls
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.CLASSES, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.CLASSES, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Searches decompiled class bodies across the artifact. */
    fun handleSearchGlobalKey(key: String, filter: DecxFilter): DecxApiResult {
        val query = mapOf("target" to key) + filter.toQuery()
        return try {
            if (key.isBlank()) {
                return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_GLOBAL, query, DecxError.EMPTY_SEARCH_KEY))
            }
            val matcher = buildMatcher(key, filter.caseSensitive, filter.regex)
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_GLOBAL, query, DecxError.INVALID_PARAMETER, "invalid regex: $key"))
            val filters = filter.compile()
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_GLOBAL, query, DecxError.INVALID_PARAMETER, "invalid filter regex"))
            val classes = decompiler.classesWithInners
                .filter { clazz -> filters.matches(clazz.fullName) }
            val matches = classes.mapNotNull { clazz ->
                try {
                    clazz.decompile()
                    val code = clazz.code ?: ""
                    if (matcher.matches(clazz.fullName) || matcher.matches(code)) {
                        AnalysisResultUtils.item(
                            id = clazz.fullName,
                            kind = ItemKind.SYMBOL,
                            title = "Class match: ${clazz.fullName.substringAfterLast('.')}",
                            content = clazz.fullName
                        )
                    } else {
                        null
                    }
                } catch (_: Exception) {
                    null
                }
            }
            val items = filter.limit(matches)
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SEARCH_GLOBAL, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_GLOBAL, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Greps one class by method body and returns matching source lines with method signatures. */
    fun handleSearchClassKey(cls: String, key: String, filter: DecxFilter): DecxApiResult {
        val query = mapOf("target" to key, "class" to cls) + filter.toQuery()
        return try {
            if (key.isBlank()) {
                return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_CLASS, query, DecxError.EMPTY_SEARCH_KEY))
            }
            val matcher = buildMatcher(key, filter.caseSensitive, filter.regex)
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_CLASS, query, DecxError.INVALID_PARAMETER, "invalid regex: $key"))
            val clazz = decompiler.searchJavaClassOrItsParentByOrigFullName(cls)
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_CLASS, query, DecxError.CLASS_NOT_FOUND, cls))
            val limit = filter.limit ?: 0
            if (limit <= 0) {
                return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SEARCH_CLASS, query, emptyList()))
            }
            clazz.decompile()
            val items = mutableListOf<Map<String, Any>>()
            for (method in clazz.methods) {
                val signature = CodeUtils.methodSignature(method)
                val lines = method.codeStr.lines()
                for ((index, line) in lines.withIndex()) {
                    if (!matcher.matches(line)) continue
                    items += AnalysisResultUtils.item(
                        id = "$signature#${index + 1}",
                        kind = ItemKind.CODE,
                        title = "$signature",
                        content = line.trim(),
                        meta = mapOf(
                            "line" to index + 1
                        )
                    )
                    if (items.size >= limit) {
                        return DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SEARCH_CLASS, query, items))
                    }
                }
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SEARCH_CLASS, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.SEARCH_CLASS, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    private fun buildMatcher(key: String, caseSensitive: Boolean, regex: Boolean): SearchMatcher? {
        return if (regex) {
            try {
                val regexOptions = if (caseSensitive) emptySet() else setOf(RegexOption.IGNORE_CASE)
                SearchMatcher.RegexSearch(Regex(key, regexOptions))
            } catch (_: PatternSyntaxException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        } else {
            SearchMatcher.LiteralSearch(key, ignoreCase = !caseSensitive)
        }
    }

    private sealed interface SearchMatcher {
        fun matches(text: String): Boolean

        data class LiteralSearch(private val key: String, private val ignoreCase: Boolean) : SearchMatcher {
            override fun matches(text: String): Boolean = text.contains(key, ignoreCase = ignoreCase)
        }

        data class RegexSearch(private val regex: Regex) : SearchMatcher {
            override fun matches(text: String): Boolean = regex.containsMatchIn(text)
        }
    }

    /** Searches method signatures by substring. */
    fun handleSearchMethod(mth: String): DecxApiResult {
        val query = mapOf("target" to mth)
        return try {
            if (mth.isBlank()) {
                return DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.SEARCH_METHOD, query, DecxError.EMPTY_SEARCH_KEY))
            }
            val lowerMethodName = mth.lowercase()
            val mths = decompiler.classesWithInners?.flatMap { clazz ->
                clazz.methods.filter { method -> method.fullName.lowercase().contains(lowerMethodName) }
            } ?: emptyList()
            val items = mths.map { method ->
                val sig = CodeUtils.methodSignature(method)
                AnalysisResultUtils.item(
                    id = sig,
                    kind = ItemKind.SYMBOL,
                    title = "Method: $sig",
                    content = sig
                )
            }
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SEARCH_METHOD, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail( AnalysisResultUtils.error(DecxKind.SEARCH_METHOD, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

    /** Returns a single method body in Java or smali form. */
    fun handleGetMethodSource(mth: String, smali: Boolean): DecxApiResult {
        val query = mapOf("target" to mth, "smali" to smali)
        return try {
            val mthPair = CodeUtils.findMethod(decompiler, mth)
                ?: return DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.METHOD_SOURCE, query, DecxError.METHOD_NOT_FOUND, mth))
            val jcls = mthPair.first
            val jmth = mthPair.second
            jcls.decompile()
            val code = if (smali) CodeUtils.extractMethodSmaliCode(jcls, jmth) else jmth.codeStr
            val signature = CodeUtils.methodSignature(jmth)
            val items = listOf(
                AnalysisResultUtils.item(
                    id = signature,
                    kind = ItemKind.CODE,
                    title = signature,
                    content = code,
                    meta = mapOf("language" to if (smali) "smali" else "java")
                )
            )
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.METHOD_SOURCE, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(AnalysisResultUtils.error(DecxKind.METHOD_SOURCE, query, DecxError.SERVER_INTERNAL_ERROR, e.message ?: "unknown"))
        }
    }

}
