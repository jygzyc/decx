package jadx.plugins.decx.service

import jadx.api.JadxDecompiler
import jadx.plugins.decx.api.DecxApiResult

enum class DecxServiceKind {
    DECOMPILER,
    UI
}

interface DecxService {
    val kind: DecxServiceKind
    val isUi: Boolean get() = kind == DecxServiceKind.UI
}

interface DecompilerBackedService : DecxService {
    val decompiler: JadxDecompiler
    override val kind: DecxServiceKind get() = DecxServiceKind.DECOMPILER
}

interface UiBackedService : DecxService {
    override val kind: DecxServiceKind get() = DecxServiceKind.UI

    fun handleGetSelectedClass(): DecxApiResult
    fun handleGetSelectedText(): DecxApiResult
}
