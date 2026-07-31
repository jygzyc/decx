package jadx.plugins.decx.utils

import jadx.api.JadxDecompiler
import jadx.api.JavaMethod

/**
 * Lazily-built, reload-invalidated inventory of class names and methods for the
 * currently loaded target. Replaces the per-call full scan that [CommonService]
 * used to do for `getClasses` / `searchMethod`.
 *
 * Built on first use from [JadxDecompiler.getClassesWithInners] (metadata only —
 * no decompilation). Cleared on target reload; the next access rebuilds lazily.
 */
object SymbolIndex {
    @Volatile
    private var classNames: List<String>? = null

    @Volatile
    private var methods: List<JavaMethod>? = null

    @Volatile
    private var builtFor: JadxDecompiler? = null

    fun classNames(decompiler: JadxDecompiler): List<String> {
        ensureBuilt(decompiler)
        return classNames!!
    }

    fun methods(decompiler: JadxDecompiler): List<JavaMethod> {
        ensureBuilt(decompiler)
        return methods!!
    }

    private fun ensureBuilt(decompiler: JadxDecompiler) {
        if (builtFor === decompiler && classNames != null) return
        synchronized(this) {
            if (builtFor === decompiler && classNames != null) return
            build(decompiler)
        }
    }

    /** Force a rebuild (e.g. after the decompiler reloads classes). */
    fun rebuild(decompiler: JadxDecompiler) {
        synchronized(this) {
            build(decompiler)
        }
    }

    /** Drop the cached inventory; the next access rebuilds lazily. */
    fun clear() {
        synchronized(this) {
            classNames = null
            methods = null
            builtFor = null
        }
    }

    private fun build(decompiler: JadxDecompiler) {
        val classes = try {
            decompiler.classesWithInners
        } catch (e: Exception) {
            LogUtils.warn("SymbolIndex build failed to enumerate classes: {}", e.message ?: "unknown")
            emptyList()
        }
        val names = ArrayList<String>(classes.size)
        val mths = ArrayList<JavaMethod>()
        for (clazz in classes) {
            try {
                names.add(clazz.fullName)
            } catch (_: Exception) {
            }
            try {
                for (m in clazz.methods) mths.add(m)
            } catch (_: Exception) {
            }
        }
        classNames = names
        methods = mths
        builtFor = decompiler
        LogUtils.info("SymbolIndex built: {} classes, {} methods", names.size, mths.size)
    }
}
