package decx.taie

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.BufferedReader
import java.io.File
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.io.Writer
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicLong

/**
 * TaiEEngine process entry point.
 *
 * Communicates with decx-core's TaiEEngineClient over stdin/stdout using
 * JSON-RPC 2.0 with Content-Length framing (same as MCP stdio transport).
 *
 * Usage:
 *   java -jar decx-taie-engine.jar --apk <file> [--rules-dir <dir>] [--android-jars <dir>] [--output-dir <dir>]
 *
 * Protocol:
 *   Each message is framed as:
 *     Content-Length: <byte_count>\r\n\r\n<json_bytes>
 *
 *   Request:  {"jsonrpc":"2.0","id":N,"method":"getRules","params":{}}
 *   Response: {"jsonrpc":"2.0","id":N,"result":[...]}
 *   Notify:   {"jsonrpc":"2.0","method":"ready","params":{"tier":1}}
 */
object TaiEEngineMain {

    private val gson = Gson()
    private val nextId = AtomicLong(0)

    @JvmStatic
    fun main(args: Array<String>) {
        val opts = parseArgs(args)

        System.err.println("[TaiEEngine] Starting with apk=${opts.apk}, rules=${opts.rulesDir}")

        // Determine if APK (has manifest) or Java
        val isApk = opts.apk.endsWith(".apk", ignoreCase = true) ||
                    opts.apk.endsWith(".dex", ignoreCase = true)

        val androidJars = opts.androidJars ?: if (isApk) AndroidSdkLocator.locatePlatformsDir() else null

        val engine = TaiEAnalysisEngine(
            inputFile = File(opts.apk),
            isApk = isApk,
            androidJarsDir = androidJars,
            outputDir = File(opts.outputDir),
            rulesDir = opts.rulesDir?.let { File(it) }
        )

        // Send "initializing" notification
        sendNotification("status", gson.toJsonTree(mapOf("state" to "initializing")).asJsonObject)

        // Initialize engine (blocking — may take minutes for large APKs)
        try {
            engine.initialize()
            sendNotification("ready", gson.toJsonTree(mapOf(
                "tier" to 1,
                "analysisReady" to engine.isAnalysisReady
            )).asJsonObject)
            System.err.println("[TaiEEngine] Ready — accepting requests")
        } catch (e: Throwable) {
            System.err.println("[TaiEEngine] Initialization failed: ${e.message}")
            sendNotification("error", gson.toJsonTree(mapOf(
                "message" to (e.message ?: "unknown")
            )).asJsonObject)
            return
        }

        // Main request loop: read from stdin, dispatch, write to stdout
        val reader = System.`in`.bufferedReader(StandardCharsets.UTF_8)
        while (true) {
            val message = try {
                readMessage(reader)
            } catch (e: Exception) {
                System.err.println("[TaiEEngine] stdin closed or error: ${e.message}")
                break
            }
            if (message == null) break

            try {
                handleRequest(message, engine)
            } catch (e: Exception) {
                System.err.println("[TaiEEngine] Error handling request: ${e.message}")
            }
        }

        System.err.println("[TaiEEngine] Shutting down")
    }

    private fun handleRequest(json: String, engine: TaiEAnalysisEngine) {
        val obj = JsonParser.parseString(json).asJsonObject
        val id = if (obj.has("id")) obj.get("id") else null
        val method = obj.get("method")?.asString ?: return
        val params = if (obj.has("params")) obj.getAsJsonObject("params") else JsonObject()

        val result: Any? = when (method) {
            "getRules" -> engine.getRuleSummaries()
            "investigate" -> {
                val ruleId = params.get("ruleId")?.asString ?: ""
                @Suppress("UNCHECKED_CAST")
                val ruleParams = parseParams(params)
                engine.investigate(ruleId, ruleParams)
            }
            "investigateCustom" -> {
                val ruleYaml = params.get("ruleYaml")?.asString ?: ""
                @Suppress("UNCHECKED_CAST")
                val ruleParams = parseParams(params)
                engine.investigateCustom(ruleYaml, ruleParams)
            }
            "callersOf" -> engine.callersOf(params.get("methodSig")?.asString ?: "")
            "calleesOf" -> engine.calleesOf(params.get("methodSig")?.asString ?: "")
            "subclassesOf" -> engine.subclassesOf(
                params.get("classSig")?.asString ?: "",
                params.get("transitive")?.asBoolean ?: true
            )
            "implementorsOf" -> engine.implementorsOf(
                params.get("ifaceSig")?.asString ?: "",
                params.get("transitive")?.asBoolean ?: true
            )
            "pointsTo" -> engine.pointsTo(
                params.get("methodSig")?.asString ?: "",
                params.get("varName")?.asString ?: "return"
            )
            "getStatus" -> mapOf(
                "ready" to engine.isReady,
                "analysisReady" to engine.isAnalysisReady
            )
            else -> {
                if (id != null) sendError(id, -32601, "Method not found: $method")
                return
            }
        }

        if (id != null) {
            sendResponse(id, result)
        }
    }

    private fun parseParams(params: JsonObject): Map<String, String> {
        if (!params.has("params") || !params.get("params").isJsonObject) return emptyMap()
        val map = mutableMapOf<String, String>()
        for ((key, value) in params.getAsJsonObject("params").entrySet()) {
            map[key] = value.asString
        }
        return map
    }

    // ------------------------------------------------------------------
    // IPC framing (Content-Length prefix, JSON-RPC 2.0)
    // ------------------------------------------------------------------

    private fun readMessage(reader: BufferedReader): String? {
        // Read headers until empty line
        var contentLength = -1
        var line = reader.readLine() ?: return null
        while (line.isNotEmpty()) {
            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                contentLength = line.substringAfter(":").trim().toIntOrNull() ?: -1
            }
            line = reader.readLine() ?: return null
        }
        if (contentLength <= 0) return null

        // Read body
        val body = CharArray(contentLength)
        var read = 0
        while (read < contentLength) {
            val n = reader.read(body, read, contentLength - read)
            if (n < 0) return null
            read += n
        }
        return String(body)
    }

    private fun sendResponse(id: Any, result: Any?) {
        val response = JsonObject()
        response.addProperty("jsonrpc", "2.0")
        response.add("id", gson.toJsonTree(id))
        response.add("result", gson.toJsonTree(result))
        writeMessage(gson.toJson(response))
    }

    private fun sendError(id: Any, code: Int, message: String) {
        val response = JsonObject()
        response.addProperty("jsonrpc", "2.0")
        response.add("id", gson.toJsonTree(id))
        val error = JsonObject()
        error.addProperty("code", code)
        error.addProperty("message", message)
        response.add("error", error)
        writeMessage(gson.toJson(response))
    }

    private fun sendNotification(method: String, params: JsonObject) {
        val notification = JsonObject()
        notification.addProperty("jsonrpc", "2.0")
        notification.addProperty("method", method)
        notification.add("params", params)
        writeMessage(gson.toJson(notification))
    }

    @Synchronized
    private fun writeMessage(json: String) {
        val bytes = json.toByteArray(StandardCharsets.UTF_8)
        val out = System.out
        out.write("Content-Length: ${bytes.size}\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
        out.write(bytes)
        out.flush()
    }

    // ------------------------------------------------------------------
    // Args parsing
    // ------------------------------------------------------------------

    private data class Options(
        val apk: String,
        val rulesDir: String? = null,
        val androidJars: String? = null,
        val outputDir: String = System.getProperty("java.io.tmpdir") + "/decx-taie-engine"
    )

    private fun parseArgs(args: Array<String>): Options {
        var apk: String? = null
        var rulesDir: String? = null
        var androidJars: String? = null
        var outputDir = System.getProperty("java.io.tmpdir") + "/decx-taie-engine"

        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "--apk" -> { i++; if (i < args.size) apk = args[i] }
                "--rules-dir" -> { i++; if (i < args.size) rulesDir = args[i] }
                "--android-jars" -> { i++; if (i < args.size) androidJars = args[i] }
                "--output-dir" -> { i++; if (i < args.size) outputDir = args[i] }
            }
            i++
        }

        if (apk == null) {
            System.err.println("Error: --apk is required")
            System.err.println("Usage: decx-taie-engine --apk <file> [--rules-dir <dir>] [--android-jars <dir>] [--output-dir <dir>]")
            System.exit(1)
        }

        return Options(apk = apk!!, rulesDir = rulesDir, androidJars = androidJars, outputDir = outputDir)
    }
}
