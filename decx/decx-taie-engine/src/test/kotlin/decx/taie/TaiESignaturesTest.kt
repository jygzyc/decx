package decx.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class TaiESignaturesTest {

    @Test
    fun `decxToTaiESignature converts standard method`() {
        val decxSig = "com.example.Foo.bar(int,java.lang.String):boolean"
        val taiESig = TaiESignatures.decxToTaiESignature(decxSig)
        assertThat(taiESig).isEqualTo("<com.example.Foo: boolean bar(int,java.lang.String)>")
    }

    @Test
    fun `decxToTaiESignature converts void return`() {
        val decxSig = "com.example.MainActivity.onCreate(android.os.Bundle):void"
        val taiESig = TaiESignatures.decxToTaiESignature(decxSig)
        assertThat(taiESig).isEqualTo("<com.example.MainActivity: void onCreate(android.os.Bundle)>")
    }

    @Test
    fun `decxToTaiESignature converts constructor`() {
        val decxSig = "com.example.Service.<init>(java.lang.String):void"
        val taiESig = TaiESignatures.decxToTaiESignature(decxSig)
        assertThat(taiESig).isEqualTo("<com.example.Service: void <init>(java.lang.String)>")
    }

    @Test
    fun `decxToTaiESignature converts inner class`() {
        val decxSig = "com.example.Outer${'$'}Inner.run():void"
        val taiESig = TaiESignatures.decxToTaiESignature(decxSig)
        assertThat(taiESig).isEqualTo("<com.example.Outer${'$'}Inner: void run()>")
    }

    @Test
    fun `decxToTaiESignature converts no-arg method`() {
        val decxSig = "com.example.Foo.toString():java.lang.String"
        val taiESig = TaiESignatures.decxToTaiESignature(decxSig)
        assertThat(taiESig).isEqualTo("<com.example.Foo: java.lang.String toString()>")
    }

    @Test
    fun `decxToTaiESignature handles invalid input`() {
        assertThat(TaiESignatures.decxToTaiESignature("invalid")).isEqualTo("<invalid>")
        assertThat(TaiESignatures.decxToTaiESignature("")).isEqualTo("<>")
    }
}
