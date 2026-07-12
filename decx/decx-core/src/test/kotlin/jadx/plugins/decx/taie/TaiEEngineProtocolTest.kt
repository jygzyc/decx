package jadx.plugins.decx.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.BufferedReader
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets

class TaiEEngineProtocolTest {

    @Test
    fun `writeMessage and readMessage round-trip`() {
        val json = """{"jsonrpc":"2.0","id":1,"method":"getRules","params":{}}"""
        val output = ByteArrayOutputStream()
        TaiEEngineProtocol.writeMessage(output, json)

        val input = ByteArrayInputStream(output.toByteArray())
        val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))
        val received = TaiEEngineProtocol.readMessage(reader)

        assertThat(received).isEqualTo(json)
    }

    @Test
    fun `handles multi-byte UTF-8 content`() {
        val json = """{"jsonrpc":"2.0","id":2,"method":"callersOf","params":{"methodSig":"com.example.Foo.bar(int):void"}}"""
        val output = ByteArrayOutputStream()
        TaiEEngineProtocol.writeMessage(output, json)

        val input = ByteArrayInputStream(output.toByteArray())
        val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))
        val received = TaiEEngineProtocol.readMessage(reader)

        assertThat(received).isEqualTo(json)
    }

    @Test
    fun `readMessage returns null on EOF`() {
        val input = ByteArrayInputStream(ByteArray(0))
        val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))
        val received = TaiEEngineProtocol.readMessage(reader)
        assertThat(received).isNull()
    }

    @Test
    fun `parseMessage extracts response result`() {
        val json = """{"jsonrpc":"2.0","id":42,"result":{"ready":true}}"""
        val msg = TaiEEngineProtocol.parseMessage(json)
        assertThat(msg.id).isNotNull
        assertThat(msg.method).isNull()
        assertThat(msg.result).isNotNull
        assertThat(msg.result!!.asJsonObject.get("ready").asBoolean).isTrue()
    }

    @Test
    fun `parseMessage extracts notification`() {
        val json = """{"jsonrpc":"2.0","method":"ready","params":{"tier":1}}"""
        val msg = TaiEEngineProtocol.parseMessage(json)
        assertThat(msg.id).isNull()
        assertThat(msg.method).isEqualTo("ready")
        assertThat(msg.params).isNotNull
        assertThat(msg.params!!.get("tier").asInt).isEqualTo(1)
    }

    @Test
    fun `parseMessage extracts error`() {
        val json = """{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"""
        val msg = TaiEEngineProtocol.parseMessage(json)
        assertThat(msg.error).isNotNull
        assertThat(msg.error!!.get("message").asString).isEqualTo("Method not found")
    }

    @Test
    fun `request creates valid JSON-RPC`() {
        val json = TaiEEngineProtocol.request(1, "getRules", mapOf("key" to "value"))
        val msg = TaiEEngineProtocol.parseMessage(json)
        assertThat(msg.id).isNotNull
        assertThat(msg.method).isEqualTo("getRules")
    }

    @Test
    fun `multiple messages in sequence`() {
        val json1 = """{"jsonrpc":"2.0","id":1,"method":"getRules","params":{}}"""
        val json2 = """{"jsonrpc":"2.0","id":2,"method":"callersOf","params":{"methodSig":"test"}}"""

        val output = ByteArrayOutputStream()
        TaiEEngineProtocol.writeMessage(output, json1)
        TaiEEngineProtocol.writeMessage(output, json2)

        val input = ByteArrayInputStream(output.toByteArray())
        val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))

        val received1 = TaiEEngineProtocol.readMessage(reader)
        val received2 = TaiEEngineProtocol.readMessage(reader)

        assertThat(received1).isEqualTo(json1)
        assertThat(received2).isEqualTo(json2)
    }
}
