package jadx.plugins.decx.server

import jadx.api.JadxDecompiler
import jadx.cli.JadxCLIArgs
import jadx.plugins.decx.Decx
import jadx.plugins.decx.DecxConstants
import jadx.plugins.decx.utils.PluginUtils

/**
 * DECX Server — Java Intelligence Analysis Platform.
 *
 * Usage:
 *   java -jar decx-server.jar <file> [options]
 *
 * DECX Options:
 *   -p, --port <port>           HTTP server port (default: 25419)
 *   --mcp                       Also start MCP Streamable HTTP server on port + 1
 *   --no-mcp                    Disable MCP server (default)
 *
 * All standard jadx-cli options are also supported.
 * Run with --help for details.
 */
object DecxServerApp {

	@JvmStatic
	fun main(args: Array<String>) {
		val (options, jadxRawArgs) = extractDecxOptionsAndFilterArgs(args)
		val port = options.port

		if (jadxRawArgs.contains("--help") || jadxRawArgs.contains("-h")) {
			printHelp()
			return
		}
		if (jadxRawArgs.contains("--version")) {
			println("DECX ${DecxConstants.getVersion()}")
			return
		}

		val jadxArgs = try {
			val cliArgs = JadxCLIArgs()
			if (!cliArgs.processArgs(jadxRawArgs)) return
			cliArgs.toJadxArgs()
		} catch (e: Exception) {
			System.err.println("Error: ${e.message}")
			System.exit(1)
			return
		}

		// Validate input file
		val inputFiles = jadxArgs.inputFiles
		if (inputFiles.isNullOrEmpty()) {
			System.err.println("Error: No file specified.")
			System.err.println("Usage: java -jar decx-server.jar <file> [options]")
			System.exit(1)
			return
		}
		val inputFile = inputFiles.first()
		if (!inputFile.exists()) {
			System.err.println("Error: File not found: ${inputFile.absolutePath}")
			System.exit(1)
			return
		}

		println("DECX Server")
		println("==========")
		println("File:   ${inputFile.absolutePath}")
		println("Port:   $port")
		println()

		println("[*] Initializing decompiler...")
		val decompiler: JadxDecompiler
		try {
			decompiler = JadxDecompiler(jadxArgs)
			decompiler.load()
		} catch (e: Exception) {
			System.err.println("Error: Failed to initialize decompiler: ${e.message}")
			System.exit(1)
			return
		}

		println("[*] Loading classes...")
		val classCount = decompiler.classesWithInners?.size ?: 0
		if (classCount == 0) {
			System.err.println("Error: No classes found in ${inputFile.name}")
			System.exit(1)
			return
		}
		println("[+] Loaded $classCount classes")

		val api = Decx.api(decompiler)
		val server = Decx.httpServer(api, port)
		val started = server.start(port)
		if (!started) {
			System.err.println("Error: Failed to start server on port $port")
			System.exit(1)
			return
		}

		val mcpServer = if (options.mcpEnabled) {
			Decx.mcpServer(api, port).also { mcp ->
				server.mcpServer = mcp
				if (!mcp.start()) {
					server.stop()
					System.err.println("Error: Failed to start MCP server on port ${mcp.mcpPort}")
					System.exit(1)
					return
				}
			}
		} else {
			null
		}

		val serverUrl = PluginUtils.buildServerUrl(port = port, running = true)
		println()
		println("[+] DECX Server running at $serverUrl")
		println("[+] API: POST ${serverUrl}/api/decx/<endpoint>")
		println("[+] Health: GET ${serverUrl}/health")
		if (mcpServer != null) {
			println("[+] MCP: ${mcpServer.mcpUrl()}")
		} else {
			println("[-] MCP: disabled (enable with --mcp)")
		}
		println()
		println("Press Ctrl+C to stop.")

		try {
			Thread.currentThread().join()
		} catch (_: InterruptedException) {
			println("\n[*] Shutting down...")
			server.stop()
		}
	}

	private data class DecxCliOptions(
		val port: Int = DecxConstants.DEFAULT_PORT,
		val mcpEnabled: Boolean = false
	)

	private fun extractDecxOptionsAndFilterArgs(args: Array<String>): Pair<DecxCliOptions, Array<String>> {
		var port = DecxConstants.DEFAULT_PORT
		var mcpEnabled = false
		val result = mutableListOf<String>()
		var i = 0
		while (i < args.size) {
			when (args[i]) {
				"--port", "-p" -> {
					i++
					if (i >= args.size) {
						System.err.println("Error: --port requires a value")
						System.exit(1)
					}
					port = args[i].toIntOrNull() ?: run {
						System.err.println("Error: Invalid port: ${args[i]}")
						System.exit(1)
						port
					}
				}
				"--mcp" -> mcpEnabled = true
				"--no-mcp" -> mcpEnabled = false
				else -> result.add(args[i])
			}
			i++
		}
		return DecxCliOptions(port = port, mcpEnabled = mcpEnabled) to result.toTypedArray()
	}

	private fun printHelp() {
		println("""
DECX Server — Java Intelligence Analysis Platform

Usage:
  java -jar decx-server.jar <file> [options]

Arguments:
  <file>                   Path to APK, DEX, JAR, AAR, or class file

DECX Options:
  -p, --port <port>           HTTP server port (default: ${DecxConstants.DEFAULT_PORT})
  --mcp                       Also start MCP Streamable HTTP server at http://127.0.0.1:<port+1>/mcp
  --no-mcp                    Disable MCP server (default)

JADX Options:
  All standard jadx-cli options are supported. Common ones:
  -j, --threads-count <n>     Processing threads count
  --show-bad-code             Show inconsistent code
  --no-imports                Disable use of import statements
  --no-inline-anonymous       Disable anonymous classes inline
  -r, --no-res                Do not decode resources
  --no-debug-info             Disable debug info parsing
  --deobf                     Activate deobfuscation
  --escape-unicode            Escape non-ASCII characters in strings
  --log-level <level>         Set log level (quiet, progress, error, warn, info, debug)

  For full list of options, see: https://github.com/skylot/jadx

Examples:
  java -jar decx-server.jar app.apk
  java -jar decx-server.jar classes.dex --port 9000
  java -jar decx-server.jar app.apk --mcp
  java -jar decx-server.jar library.jar -j 8 --no-res --show-bad-code
  java -jar decx-server.jar app.apk --deobf --no-imports

MCP:
  Enable with --mcp. MCP listens on HTTP port + 1, e.g. --port 9000 exposes http://127.0.0.1:9001/mcp

API Endpoints:
  POST /api/decx/get_classes        Get classes (params: filter)
  POST /api/decx/get_class_source       Get class source (params: cls, smali, filter.limit)
  POST /api/decx/get_method_source      Get method source (params: mth, smali)
  POST /api/decx/search_global_key      Search globally (params: key, search)
  POST /api/decx/search_class_key       Grep one class (params: cls, key, grep)
  POST /api/decx/search_method          Search methods (params: mth)
  POST /api/decx/get_method_xref        Method cross-references (params: mth)
  POST /api/decx/get_app_manifest       Get AndroidManifest.xml
  POST /api/decx/get_exported_components  Get exported components
  GET  /health                           Health check
        """.trimIndent())
		println()
		println("DECX version: ${DecxConstants.getVersion()}")
		println("JADX core:   (bundled)")
		println()
		println("License: GNU General Public License v3.0")
		println("Source:      https://github.com/jygzyc/decx")
		println()
		print("CLI tool connects to this server using: decx -P <port>\n")
		println()
	}
}
