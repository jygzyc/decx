package jadx.plugins.decx.server

/**
 * JADX argument normalization for DECX.
 *
 * The CLI passes user-supplied jadx flags through unchanged; the server applies the DECX
 * contract before handing them to jadx-cli:
 *  - drop `--deobf` (DECX relies on original symbol names),
 *  - rewrite `--rename-flags` values: drop `printable`, map `all` to `case,valid`, keep `none`
 *    and unparseable values for jadx to reject or accept (`-rf` is a DECX alias and is
 *    normalized to jadx's `--rename-flags`),
 *  - default `--show-bad-code`, `--no-imports`, `-Pdex-input.verify-checksum=no` and
 *    `--rename-flags case,valid`.
 *
 * Surviving tokens keep their original order and positional inputs are never reordered;
 * injected defaults are appended after them.
 */
object JadxPassthroughArgs {

	private val RENAME_FLAGS_LONG = "--rename-flags"
	private val RENAME_FLAGS_ARGS = listOf(RENAME_FLAGS_LONG, "-rf")
	private val KNOWN_RENAME_FLAGS = setOf("CASE", "VALID", "PRINTABLE", "ALL")
	private val RENAME_FLAGS_EQ = Regex("^(--rename-flags|-rf)=(.*)$")

	/** Normalizes jadx passthrough arguments (without the DECX `--port`/`--mcp` options). */
	fun normalize(args: List<String>): List<String> {
		val result = stripPrintableRenameFlag(args.filter { it != "--deobf" }).toMutableList()
		if ("--show-bad-code" !in result) {
			result.add("--show-bad-code")
		}
		if ("--no-imports" !in result) {
			result.add("--no-imports")
		}
		if ("-Pdex-input.verify-checksum=no" !in result) {
			result.add("-Pdex-input.verify-checksum=no")
		}
		if (!hasRenameFlagsArg(result)) {
			result.add("--rename-flags")
			result.add("case,valid")
		}
		return result
	}

	/**
	 * Rewrites one rename-flags value. Returns null when the value must be kept as is:
	 * it is empty, or it contains a token jadx does not know (jadx decides on errors).
	 *
	 * Both the `--rename-flags` spelling and the DECX `-rf` alias are rewritten; only
	 * the former is a jadx option, so `-rf` is always rewritten to `--rename-flags`
	 * (a surviving `-rf` would be treated by jadx as an input file).
	 */
	fun sanitizeRenameFlagsValue(value: String): String? {
		val raw = value.trim()
		if (raw.isEmpty()) {
			return null
		}
		when (raw.uppercase()) {
			"NONE" -> return "NONE"
			"ALL" -> return "CASE,VALID"
		}
		val tokens = raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }
		if (tokens.isEmpty() || tokens.any { it.uppercase() !in KNOWN_RENAME_FLAGS }) {
			return null
		}
		val kept = tokens.filter { it.uppercase() != "PRINTABLE" }
		return if (kept.isNotEmpty()) kept.joinToString(",") else "NONE"
	}

	private fun hasRenameFlagsArg(args: List<String>): Boolean =
		args.any { arg ->
			arg in RENAME_FLAGS_ARGS || RENAME_FLAGS_ARGS.any { arg.startsWith("$it=") }
		}

	private fun stripPrintableRenameFlag(args: List<String>): List<String> {
		val result = mutableListOf<String>()
		var i = 0
		while (i < args.size) {
			val arg = args[i]
			val eqMatch = RENAME_FLAGS_EQ.find(arg)
			when {
				arg in RENAME_FLAGS_ARGS -> {
					val value = args.getOrElse(i + 1) { "" }
					result.add(RENAME_FLAGS_LONG)
					result.add(sanitizeRenameFlagsValue(value) ?: value)
					i += 2
				}
				eqMatch != null -> {
					val value = eqMatch.groupValues[2]
					result.add("$RENAME_FLAGS_LONG=${sanitizeRenameFlagsValue(value) ?: value}")
					i++
				}
				else -> {
					result.add(arg)
					i++
				}
			}
		}
		return result
	}
}
