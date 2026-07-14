package decx.taie

import pascal.taie.analysis.pta.plugin.taint.IndexRef
import pascal.taie.analysis.pta.plugin.taint.TaintTransfer
import pascal.taie.analysis.pta.plugin.util.InvokeUtils
import pascal.taie.language.classes.ClassHierarchy
import pascal.taie.language.classes.JMethod
import pascal.taie.language.type.TypeSystem

/**
 * Library taint transfer rules — models how taint flows through common
 * container/utility methods where the actual implementation is opaque
 * or in framework code that Tai-e's PTA may not deeply analyze.
 *
 * Aligned with AppShark's VariableFlowRule + PointerFlowRule from
 * EngineConfig.json5. Key concept: the "@this.data" synthetic field
 * represents "all merged field contents" of an object — used for
 * Intent/Bundle/Map where specific field names are unknown.
 *
 * In Tai-e, transfers are expressed as TaintTransfer(method, from, to, type).
 * We use IndexRef positions:
 * - InvokeUtils.BASE (-1) = @this (receiver)
 * - InvokeUtils.RESULT (-2) = return value
 * - 0, 1, 2... = parameter indices
 *
 * Note: Tai-e's TaintTransfer does NOT have a direct "@this.data" concept.
 * Instead, we model container semantics through explicit method-to-method
 * transfers. For example, for Bundle.getString(key):
 *   transfer: Bundle.getString, from=BASE, to=RESULT
 *   (taint on the Bundle object flows to the return value)
 */
object DecxTaintTransfer {

    /**
     * Returns taint transfer rules for common Android/Java container methods.
     * These help taint analysis track data flow through framework methods
     * whose bodies may not be deeply analyzed.
     */
    fun getTransfers(hierarchy: ClassHierarchy, typeSystem: TypeSystem): List<TaintTransfer> {
        val transfers = mutableListOf<TaintTransfer>()

        // Helper: resolve a method signature and add transfer
        fun addTransfer(sig: String, fromIdx: Int, toIdx: Int, type: String = "java.lang.Object") {
            val method = resolveMethod(sig, hierarchy) ?: return
            val from = IndexRef(IndexRef.Kind.VAR, fromIdx, null)
            val to = IndexRef(IndexRef.Kind.VAR, toIdx, null)
            val taintType = typeSystem.getType(type) ?: typeSystem.getType("java.lang.Object")
            transfers.add(TaintTransfer(method, from, to, taintType))
        }

        // --- StringBuilder / StringBuffer ---
        addTransfer("<java.lang.StringBuilder: java.lang.StringBuilder append(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.lang.StringBuilder: java.lang.StringBuilder append(java.lang.Object)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.lang.StringBuilder: java.lang.String toString()>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.lang.StringBuffer: java.lang.StringBuffer append(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.lang.StringBuffer: java.lang.String toString()>",
            InvokeUtils.BASE, InvokeUtils.RESULT)

        // --- Intent (container semantics: putExtra → getExtra) ---
        // putExtra(key, value): value taints the Intent (this)
        addTransfer("<android.content.Intent: android.content.Intent putExtra(java.lang.String,java.lang.String)>",
            1, InvokeUtils.BASE)
        addTransfer("<android.content.Intent: android.content.Intent putExtra(java.lang.String,int)>",
            1, InvokeUtils.BASE)
        addTransfer("<android.content.Intent: android.content.Intent putExtra(java.lang.String,boolean)>",
            1, InvokeUtils.BASE)
        addTransfer("<android.content.Intent: android.content.Intent putExtras(android.os.Bundle)>",
            0, InvokeUtils.BASE)
        // getExtra(key): Intent (this) taints the return value
        addTransfer("<android.content.Intent: java.lang.String getStringExtra(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<android.content.Intent: android.os.Parcelable getParcelableExtra(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<android.content.Intent: java.lang.String[] getStringArrayExtra(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)

        // --- Bundle (container semantics) ---
        addTransfer("<android.os.Bundle: java.lang.String getString(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<android.os.Bundle: android.os.Parcelable getParcelable(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<android.os.Bundle: void putString(java.lang.String,java.lang.String)>",
            1, InvokeUtils.BASE)

        // --- Map (container semantics) ---
        addTransfer("<java.util.HashMap: java.lang.Object get(java.lang.Object)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.util.HashMap: java.lang.Object put(java.lang.Object,java.lang.Object)>",
            1, InvokeUtils.BASE)
        addTransfer("<java.util.Map: java.lang.Object get(java.lang.Object)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)

        // --- Uri ---
        addTransfer("<android.net.Uri: java.lang.String getPath()>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<android.net.Uri: java.lang.String getQuery()>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<android.net.Uri: android.net.Uri parse(java.lang.String)>",
            0, InvokeUtils.RESULT)

        // --- String operations ---
        addTransfer("<java.lang.String: byte[] getBytes()>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.lang.String: char[] toCharArray()>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.lang.String: java.lang.String concat(java.lang.String)>",
            InvokeUtils.BASE, InvokeUtils.RESULT)
        addTransfer("<java.lang.String: java.lang.String concat(java.lang.String)>",
            0, InvokeUtils.RESULT)
        addTransfer("<java.lang.String: java.lang.String format(java.lang.String,java.lang.Object[])",
            0, InvokeUtils.RESULT)
        addTransfer("<java.lang.String: java.lang.String valueOf(java.lang.Object)>",
            0, InvokeUtils.RESULT)
        addTransfer("<java.lang.StringBuilder: java.lang.StringBuilder append(java.lang.String)>",
            0, InvokeUtils.RESULT)

        System.err.println("[DecxTaintTransfer] Generated ${transfers.size} taint transfer rule(s)")
        return transfers
    }

    private fun resolveMethod(sig: String, hierarchy: ClassHierarchy): JMethod? {
        return try {
            hierarchy.getMethod(sig)
        } catch (_: Exception) {
            null
        }
    }
}
