package jadx.plugins.decx.ui

import jadx.api.plugins.JadxPluginContext
import jadx.api.plugins.gui.JadxGuiContext
import jadx.plugins.decx.server.DecxServer
import jadx.plugins.decx.server.DecxMcpServer
import jadx.plugins.decx.utils.PluginUtils
import jadx.plugins.decx.utils.PreferencesManager
import java.awt.FlowLayout
import javax.swing.*
import javax.swing.Timer

class DecxUIManager(
    private val pluginContext: JadxPluginContext,
    private val server: DecxServer,
    private val mcpServer: DecxMcpServer
) {
    private var mcpAutoStartCheckbox: JCheckBox? = null
    private var portField: JTextField? = null

    // Refreshable UI components
    private var decxStatusLabel: JLabel? = null
    private var mcpStatusLabel: JLabel? = null
    private var urlLabel: JLabel? = null
    private var mcpUrlLabel: JLabel? = null
    private var startMcpBtn: JButton? = null
    private var stopMcpBtn: JButton? = null

    fun initializeGuiComponents(guiContext: JadxGuiContext) {
        guiContext.addMenuAction("DECX Settings") {
            showSettingsDialog()
        }
    }

    private fun showSettingsDialog() {
        val panel = buildPanel()
        val optionPane = JOptionPane(panel, JOptionPane.PLAIN_MESSAGE, JOptionPane.OK_CANCEL_OPTION)

        // Refresh status every 1s while dialog is open
        val refreshTimer = Timer(1000) { refreshStatus() }
        refreshTimer.start()

        val dialog = optionPane.createDialog(pluginContext.guiContext?.mainFrame, "DECX Settings")
        dialog.isModal = true

        // Measure the actual preferred size of the content, then add padding
        panel.setSize(panel.preferredSize)
        val contentPreferred = panel.preferredSize
        val dialogWidth = contentPreferred.width.coerceAtLeast(420) + 40
        val dialogHeight = contentPreferred.height.coerceAtLeast(300) + 60
        dialog.setSize(dialogWidth, dialogHeight)
        dialog.setLocationRelativeTo(pluginContext.guiContext?.mainFrame)
        dialog.isVisible = true

        refreshTimer.stop()

        if (optionPane.value == JOptionPane.OK_OPTION) {
            saveSettings()
        }
    }

    private fun buildPanel(): JPanel {
        val panel = JPanel()
        panel.layout = BoxLayout(panel, BoxLayout.Y_AXIS)
        panel.border = BorderFactory.createEmptyBorder(10, 10, 10, 10)

        // Server Status
        val statusTitle = JLabel("Server Status")
        statusTitle.font = statusTitle.font.deriveFont(java.awt.Font.BOLD, 12f)
        statusTitle.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(statusTitle)

        decxStatusLabel = JLabel()
        decxStatusLabel!!.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(decxStatusLabel)

        mcpStatusLabel = JLabel()
        mcpStatusLabel!!.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(mcpStatusLabel)

        urlLabel = JLabel()
        urlLabel!!.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(urlLabel)

        mcpUrlLabel = JLabel()
        mcpUrlLabel!!.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(mcpUrlLabel)

        panel.add(Box.createVerticalStrut(10))

        // Port Setting
        val portTitle = JLabel("Port Setting")
        portTitle.font = portTitle.font.deriveFont(java.awt.Font.BOLD, 12f)
        portTitle.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(portTitle)

        portField = JTextField(PreferencesManager.getPort().toString(), 8)
        panel.add(createRowWithComponent("New Port:", portField!!))

        panel.add(Box.createVerticalStrut(10))

        // MCP Settings
        val mcpTitle = JLabel("MCP Settings")
        mcpTitle.font = mcpTitle.font.deriveFont(java.awt.Font.BOLD, 12f)
        mcpTitle.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(mcpTitle)

        mcpAutoStartCheckbox = JCheckBox("Auto-start MCP with DECX")
        mcpAutoStartCheckbox!!.isSelected = PreferencesManager.getMcpAutoStart()
        mcpAutoStartCheckbox!!.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        panel.add(mcpAutoStartCheckbox)

        panel.add(createRow("Implementation:", "Kotlin SDK"))

        panel.add(Box.createVerticalStrut(10))

        // MCP Control Buttons
        val buttonPanel = JPanel(FlowLayout(FlowLayout.LEFT))
        buttonPanel.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        startMcpBtn = JButton("Start MCP")
        startMcpBtn!!.addActionListener { startMcp() }
        stopMcpBtn = JButton("Stop MCP")
        stopMcpBtn!!.addActionListener { stopMcp() }
        buttonPanel.add(startMcpBtn)
        buttonPanel.add(stopMcpBtn)
        panel.add(buttonPanel)

        refreshStatus()
        return panel
    }

    private fun refreshStatus() {
        SwingUtilities.invokeLater {
            val isServerRunning = server.isRunning
            val isMcpRunning = mcpServer.isRunning()
            val currentPort = PreferencesManager.getPort()
            val url = PluginUtils.buildServerUrl(port = currentPort)
            val mcpUrl = mcpServer.mcpUrl()

            decxStatusLabel?.text = "DECX:  ${if (isServerRunning) "Running" else "Stopped"}"
            mcpStatusLabel?.text = "MCP:   ${if (isMcpRunning) "Running" else "Stopped"}"
            urlLabel?.text = "URL:   $url"
            mcpUrlLabel?.text = "MCP URL: $mcpUrl"

            startMcpBtn?.isEnabled = !isMcpRunning
            stopMcpBtn?.isEnabled = isMcpRunning
        }
    }

    private fun createRow(label: String, value: String): JPanel {
        val row = JPanel(FlowLayout(FlowLayout.LEFT))
        row.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        row.add(JLabel("$label $value"))
        return row
    }

    private fun createRowWithComponent(label: String, component: JComponent): JPanel {
        val row = JPanel(FlowLayout(FlowLayout.LEFT))
        row.alignmentX = java.awt.Component.LEFT_ALIGNMENT
        row.add(JLabel(label))
        row.add(component)
        return row
    }

    private fun saveSettings() {
        val newPort = portField?.text?.trim()?.toIntOrNull()
        if (newPort != null && newPort != PreferencesManager.getPort() && newPort in 1024..65535) {
            PreferencesManager.setPort(newPort)
            restartServers(newPort)
            return
        }

        mcpAutoStartCheckbox?.let {
            PreferencesManager.setMcpAutoStart(it.isSelected)
        }
    }

    private fun restartServers(newPort: Int) {
        Thread {
            try {
                val mcpWasRunning = mcpServer.isRunning()
                mcpServer.stop()
                server.stop()
                Thread.sleep(500)
                mcpServer.updatePort(newPort)
                server.start(newPort)
                if (mcpWasRunning || PreferencesManager.getMcpAutoStart()) {
                    Thread.sleep(1000)
                    mcpServer.start()
                }
                SwingUtilities.invokeLater {
                    JOptionPane.showMessageDialog(
                        pluginContext.guiContext?.mainFrame,
                        "Servers restarted on port $newPort",
                        "Success",
                        JOptionPane.INFORMATION_MESSAGE
                    )
                    refreshStatus()
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater {
                    JOptionPane.showMessageDialog(
                        pluginContext.guiContext?.mainFrame,
                        "Failed to restart servers: ${e.message}",
                        "Error",
                        JOptionPane.ERROR_MESSAGE
                    )
                }
            }
        }.apply { isDaemon = true }.start()
    }

    private fun startMcp() {
        Thread {
            val success = mcpServer.start()
            SwingUtilities.invokeLater {
                refreshStatus()
                JOptionPane.showMessageDialog(
                    pluginContext.guiContext?.mainFrame,
                    if (success) "MCP Server started" else "Failed to start MCP Server",
                    "MCP",
                    if (success) JOptionPane.INFORMATION_MESSAGE else JOptionPane.ERROR_MESSAGE
                )
            }
        }.apply { isDaemon = true }.start()
    }

    private fun stopMcp() {
        Thread {
            mcpServer.stop()
            SwingUtilities.invokeLater {
                refreshStatus()
                JOptionPane.showMessageDialog(
                    pluginContext.guiContext?.mainFrame,
                    "MCP Server stopped",
                    "MCP",
                    JOptionPane.INFORMATION_MESSAGE
                )
            }
        }.apply { isDaemon = true }.start()
    }
}
