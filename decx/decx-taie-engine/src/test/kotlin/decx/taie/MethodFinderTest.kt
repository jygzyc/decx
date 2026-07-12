package decx.taie

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class MethodFinderTest {

    @Test
    fun `parses standard Tai-e signature`() {
        val parts = MethodFinder.parse("<com.example.Foo: boolean bar(int,java.lang.String)>")
        assertThat(parts).isNotNull
        assertThat(parts!!.className).isEqualTo("com.example.Foo")
        assertThat(parts.returnType).isEqualTo("boolean")
        assertThat(parts.methodName).isEqualTo("bar")
        assertThat(parts.argTypes).isEqualTo("(int,java.lang.String)")
    }

    @Test
    fun `parses wildcard pattern`() {
        val parts = MethodFinder.parse("<*: * startActivit*(*)>")
        assertThat(parts).isNotNull
        assertThat(parts!!.className).isEqualTo("*")
        assertThat(parts.returnType).isEqualTo("*")
        assertThat(parts.methodName).isEqualTo("startActivit*")
        assertThat(parts.argTypes).isEqualTo("(*)")
    }

    @Test
    fun `parses no-arg method`() {
        val parts = MethodFinder.parse("<com.example.Foo: java.lang.String toString()>")
        assertThat(parts).isNotNull
        assertThat(parts!!.argTypes).isEqualTo("()")
    }

    @Test
    fun `parses inner class`() {
        val parts = MethodFinder.parse("<com.example.Outer${'$'}Inner: void run()>")
        assertThat(parts).isNotNull
        assertThat(parts!!.className).isEqualTo("com.example.Outer${'$'}Inner")
    }

    @Test
    fun `returns null for invalid pattern`() {
        assertThat(MethodFinder.parse("not a pattern")).isNull()
        assertThat(MethodFinder.parse("<missing colon>")).isNull()
        assertThat(MethodFinder.parse("")).isNull()
    }
}
