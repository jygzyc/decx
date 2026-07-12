package jadx.plugins.decx.taie

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.BufferedReader
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets

/**
 * Content-Length framed JSON-RPC 2.0 protocol for IPC between decx-core
 * (TaiEEngineClient) and the TaiEEngine process (TaiEEngineMain).
 *
 * Message format (same as MCP stdio transport):
 * ```
 * Content-Length: <byte_count>\r\n\r\n<json_bytes>
 * ```
 *
 * All JSON is UTF-8. stderr is NOT part of the protocol stream.
 */
object TaiEEngineProtocol {

    private val gson = Gson()

    /**
     * Reads a single framed message from [reader].
     * Returns the JSON string, or null on EOF.
     */
    fun readMessage(reader: BufferedReader): String? {
        var contentLength = -1
        var line = reader.readLine() ?: return null
        while (line.isNotEmpty()) {
            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                contentLength = line.substringAfter(":").trim().toIntOrNull() ?: -1
            }
            line = reader.readLine() ?: return null
        }
        if (contentLength <= 0) return null

        val body = CharArray(contentLength)
        var read = 0
        while (read < contentLength) {
            val n = reader.read(body, read, contentLength - read)
            if (n < 0) return null
            read += n
        }
        return String(body)
    }

    /**
     * Writes a framed message to [output].
     */
    fun writeMessage(output: OutputStream, json: String) {
        synchronized(output) {
            val bytes = json.toByteArray(StandardCharsets.UTF_8)
            output.write("Content-Length: ${bytes.size}\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
            output.write(bytes)
            output.flush()
        }
    }

    /**
     * Creates a JSON-RPC request object.
     */
    fun request(id: Long, method: String, params: Map<String, Any?> = emptyMap()): String {
        val obj = JsonObject()
        obj.addProperty("jsonrpc", "2.0")
        obj.addProperty("id", id)
        obj.addProperty("method", method)
        obj.add("params", gson.toJsonTree(params))
        return gson.toJson(obj)
    }

    /**
     * Parses a JSON-RPC response/notification.
     */
    fun parseMessage(json: String): ParsedMessage {
        val obj = JsonParser.parseString(json).asJsonObject
        val id = if (obj.has("id") && !obj.get("id").isJsonNull) obj.get("id") else null
        val method = if (obj.has("method")) obj.get("method").asString else null
        val result = if (obj.has("result")) obj.get("result") else null
        val error = if (obj.has("error")) obj.getAsJsonObject("error") else null
        val params = if (obj.has("params")) obj.getAsJsonObject("params") else null
        return ParsedMessage(id, method, result, error, params)
    }

    data class ParsedMessage(
        val id: Any?,          // request id (for responses), null for notifications
        val method: String?,   // method name (for requests/notifications)
        val result: JsonElement?, // result (for responses)
        val error: JsonObject?,   // error object (for error responses)
        val params: JsonObject?   // params (for notifications)
    )
}
