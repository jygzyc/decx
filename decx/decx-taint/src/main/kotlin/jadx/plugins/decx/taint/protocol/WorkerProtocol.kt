package jadx.plugins.decx.taint.protocol

import com.google.gson.Gson
import com.google.gson.JsonSyntaxException
import java.io.BufferedReader
import java.io.Writer

/**
 * NDJSON encoding/decoding of [WorkerMessage] over the worker's stdin/stdout.
 * One JSON object per line; protocol errors surface as [ProtocolException].
 */
object WorkerProtocol {

    private val gson = Gson()

    class ProtocolException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

    fun encode(message: WorkerMessage): String = gson.toJson(message)

    fun decode(line: String): WorkerMessage {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) throw ProtocolException("empty line")
        return try {
            gson.fromJson(trimmed, WorkerMessage::class.java)
        } catch (e: JsonSyntaxException) {
            throw ProtocolException("malformed message: ${e.message}", e)
        }
    }

    /** Write one encoded message on its own line. */
    fun write(writer: Writer, message: WorkerMessage) {
        writer.write(encode(message))
        writer.write("\n")
        writer.flush()
    }

    /** Read one message; null on clean EOF. */
    fun read(reader: BufferedReader): WorkerMessage? {
        val line = reader.readLine() ?: return null
        return decode(line)
    }
}
