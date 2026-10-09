# Real decompilation fixtures

- `sieve.apk` is the existing repository's real Sieve Android application,
  copied unchanged from `origin/main:decx-cli/tests/fixtures/sieve.apk` at
  `d26fd67`. Package: `com.withsecure.example.sieve`. SHA-256:
  `85fe7a89866728e3990c11aeb8768ef5ba76accd9893ca6553d782b871312bdf`.
  It contains actual DEX code and a binary Android manifest, not generated ZIP
  stubs. Tests statically decompile its SQL content provider, enumerate its
  classes and find the provider URI in an actual DEX instruction. The APK is
  never installed or executed. This move does not assert a new upstream license.
- `native-probe.c` is DECX-owned Apache-2.0 test source. A real host C compiler
  builds a Mach-O, ELF or PE executable in an isolated temporary directory.
  Tests execute it, ask the officially installed Kuna to recover its C bodies,
  compile those recovered bodies, then compare both executables on seven
  inputs, including the conditional branch and negative arithmetic. They also
  check actual project-export files and their index byte offsets. Windows
  exports the functions so the PE fixture is discoverable without depending
  on PDB support.

No fake analyzer, embedded precomputed decompilation, synthetic DEX or mocked
HTTP response is used in these functional tests. Temporary build/output files
are removed afterward; installed tool provenance remains in the explicit test
prefix for diagnosis. Do not substitute customer or proprietary APKs.
