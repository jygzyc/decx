package jadx.plugins.decx.service

import jadx.api.plugins.JadxPluginContext
import jadx.plugins.decx.api.DecxApiResult
import jadx.plugins.decx.api.DecxKind
import jadx.plugins.decx.api.DecxError
import jadx.plugins.decx.utils.AnalysisResultUtils
import jadx.plugins.decx.utils.ItemKind
import java.awt.Component
import java.awt.Container
import javax.swing.JTextArea

class UIService(private val pluginContext: JadxPluginContext) : UiBackedService {

    private fun findTextArea(component: Component): JTextArea? {
        return when (component) {
            is JTextArea -> component
            is Container -> {
                component.components.forEach { child ->
                    findTextArea(child)?.let { return it }
                }
                null
            }
            else -> null
        }
    }

    override fun handleGetSelectedClass(): DecxApiResult {
        return try {
            val mainWindow = pluginContext.guiContext?.mainFrame as? jadx.gui.ui.MainWindow
                ?: return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.SELECTED_CLASS, emptyMap(), DecxError.NOT_GUI_MODE)
                )
            val tabs = mainWindow.tabbedPane
            val className = if (tabs.selectedIndex != -1) tabs.getTitleAt(tabs.selectedIndex) else ""
            val selectedComponent = tabs.selectedComponent
                ?: return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.SELECTED_CLASS, mapOf("target" to className), DecxError.INVALID_PARAMETER, "No selected component")
                )
            val textArea = findTextArea(selectedComponent)
            val query = mapOf("target" to className)
            val items = listOf(AnalysisResultUtils.item(
                id = className, kind = ItemKind.CODE, title = className,
                content = textArea?.selectedText ?: "", meta = mapOf("language" to "java")
            ))
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SELECTED_CLASS, query, items))
        } catch (e: Exception) {
            DecxApiResult.fail(
                AnalysisResultUtils.error(
                    DecxKind.SELECTED_CLASS,
                    emptyMap(),
                    DecxError.SERVER_INTERNAL_ERROR,
                    e.message ?: "unknown"
                )
            )
        }
    }

    override fun handleGetSelectedText(): DecxApiResult {
        return try {
            val mainWindow = pluginContext.guiContext?.mainFrame as? jadx.gui.ui.MainWindow
                ?: return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.SELECTED_TEXT, emptyMap(), DecxError.NOT_GUI_MODE)
                )
            val selectedComponent = mainWindow.tabbedPane.selectedComponent
                ?: return DecxApiResult.fail(
                    AnalysisResultUtils.error(DecxKind.SELECTED_TEXT, emptyMap(), DecxError.INVALID_PARAMETER, "No selected component")
                )
            val textArea = findTextArea(selectedComponent)
            val items = listOf(AnalysisResultUtils.item(
                id = "selected_text", kind = ItemKind.CODE, title = "Selected Text",
                content = textArea?.selectedText ?: ""
            ))
            DecxApiResult.ok(AnalysisResultUtils.success(DecxKind.SELECTED_TEXT, items = items))
        } catch (e: Exception) {
            DecxApiResult.fail(
                AnalysisResultUtils.error(
                    DecxKind.SELECTED_TEXT,
                    emptyMap(),
                    DecxError.SERVER_INTERNAL_ERROR,
                    e.message ?: "unknown"
                )
            )
        }
    }
}
