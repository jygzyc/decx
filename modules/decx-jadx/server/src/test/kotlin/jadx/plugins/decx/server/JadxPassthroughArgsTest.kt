package jadx.plugins.decx.server

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class JadxPassthroughArgsTest {

	private val defaults = listOf(
		"--show-bad-code",
		"--no-imports",
		"-Pdex-input.verify-checksum=no",
		"--rename-flags",
		"case,valid"
	)

	private fun assertNormalized(input: List<String>, expected: List<String>) {
		assertEquals(expected, JadxPassthroughArgs.normalize(input))
	}

	@Test
	fun `adds DECX defaults to an empty argument list`() {
		assertNormalized(emptyList(), defaults)
	}

	@Test
	fun `drops deobfuscation and appends the defaults`() {
		assertNormalized(listOf("--deobf"), defaults)
	}

	@Test
	fun `keeps the original option order and appends defaults last`() {
		assertNormalized(
			listOf("--threads-count", "4", "--deobf", "--no-imports"),
			listOf("--threads-count", "4", "--no-imports", "--show-bad-code", "-Pdex-input.verify-checksum=no", "--rename-flags", "case,valid")
		)
	}

	@Test
	fun `does not duplicate defaults that are already provided`() {
		assertNormalized(
			listOf("--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no", "--deobf"),
			listOf("--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no", "--rename-flags", "case,valid")
		)
	}

	@Test
	fun `matches options exactly, not by prefix`() {
		assertNormalized(
			listOf("--show-bad-code=true", "-Pdex-input.verify-checksum=yes"),
			listOf("--show-bad-code=true", "-Pdex-input.verify-checksum=yes", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no", "--rename-flags", "case,valid")
		)
	}

	@Test
	fun `keeps deobf variants untouched`() {
		assertNormalized(
			listOf("--deobf-min", "2", "--deobf"),
			listOf("--deobf-min", "2", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no", "--rename-flags", "case,valid")
		)
	}

	@Test
	fun `strips the printable token from a rename flags value`() {
		assertNormalized(
			listOf("--rename-flags", "case,valid,printable"),
			listOf("--rename-flags", "case,valid", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `maps a printable-only rename flags value to NONE`() {
		assertNormalized(
			listOf("--rename-flags", "printable"),
			listOf("--rename-flags", "NONE", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `rewrites all and case-insensitive values`() {
		assertNormalized(listOf("--rename-flags", "all"), listOf("--rename-flags", "CASE,VALID") + listOf("--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no"))
		assertNormalized(listOf("--rename-flags=PRINTABLE"), listOf("--rename-flags=NONE", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no"))
		assertNormalized(listOf("--rename-flags=Printable,Valid"), listOf("--rename-flags=Valid", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no"))
	}

	@Test
	fun `normalizes the -rf alias to --rename-flags`() {
		assertNormalized(
			listOf("-rf", "case,printable"),
			listOf("--rename-flags", "case", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
		assertNormalized(
			listOf("-rf=case"),
			listOf("--rename-flags=case", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
		assertNormalized(
			listOf("-rf=printable"),
			listOf("--rename-flags=NONE", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `rewrites every rename flags occurrence independently`() {
		assertNormalized(
			listOf("--rename-flags", "printable", "--rename-flags", "case,printable"),
			listOf("--rename-flags", "NONE", "--rename-flags", "case", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `keeps duplicates of already provided defaults`() {
		assertNormalized(
			listOf("--show-bad-code", "--show-bad-code"),
			listOf("--show-bad-code", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no", "--rename-flags", "case,valid")
		)
	}

	@Test
	fun `keeps a mix of legal rename tokens without expanding all`() {
		assertNormalized(
			listOf("--rename-flags=case,all"),
			listOf("--rename-flags=case,all", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `does not inject rename flags when any form is present`() {
		for (input in listOf(listOf("-rf=case"), listOf("--rename-flags=case,valid"), listOf("-rf", "case,valid"))) {
			val normalized = JadxPassthroughArgs.normalize(input)
			assertEquals(1, normalized.count { it == "--rename-flags" || it == "-rf" || it.startsWith("--rename-flags=") || it.startsWith("-rf=") }) {
				"rename flags appeared more than once for $input: $normalized"
			}
		}
	}

	@Test
	fun `keeps none and unknown rename values without double-injecting`() {
		assertNormalized(
			listOf("--rename-flags", "none"),
			listOf("--rename-flags", "NONE", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
		assertNormalized(
			listOf("--rename-flags", "bogus"),
			listOf("--rename-flags", "bogus", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
		assertNormalized(
			listOf("--rename-flags", "none,printable"),
			listOf("--rename-flags", "none,printable", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `handles a missing or flag-like rename value`() {
		assertNormalized(
			listOf("--rename-flags"),
			listOf("--rename-flags", "", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
		assertNormalized(
			listOf("--rename-flags", "--no-res"),
			listOf("--rename-flags", "--no-res", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `normalizes a value that lands in the rename slot after deobf removal`() {
		assertNormalized(
			listOf("--rename-flags", "--deobf", "case"),
			listOf("--rename-flags", "case", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
		assertNormalized(
			listOf("--deobf", "case,printable"),
			listOf("case,printable", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no", "--rename-flags", "case,valid")
		)
	}

	@Test
	fun `trims whitespace around rename tokens`() {
		assertNormalized(
			listOf("--rename-flags", "case, valid "),
			listOf("--rename-flags", "case,valid", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no")
		)
	}

	@Test
	fun `preserves positional inputs`() {
		assertNormalized(
			listOf("app.apk", "rename.jadx.kts", "--no-res"),
			listOf("app.apk", "rename.jadx.kts", "--no-res", "--show-bad-code", "--no-imports", "-Pdex-input.verify-checksum=no", "--rename-flags", "case,valid")
		)
	}
}
