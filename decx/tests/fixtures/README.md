# Offline installer test tools

These manifests are loaded from temporary subproject directories by the integration tests. They are **not** included in the shipped manifest catalog.

| Fixture | Payload used by the test | What it exercises |
| --- | --- | --- |
| `js-tool/` | A locally served JS release archive with an imported module and `package.json` | Checksum, Node launcher, module tree, `decx -m` |
| `python-tool/` | A pure-Python wheel built locally from `pyprobe/` | Real private venv, offline pip, console script, `decx -m` |
| `bin-tool/` | A locally served archive containing the host's native Node executable, renamed `binprobe` | Checksum, executable install, direct launch, `decx -m` |

The Python test sets `PIP_NO_INDEX=1` and `PIP_FIND_LINKS` to its temporary wheelhouse; no PyPI access or installation into the user's environment is needed. The binary fixture reuses Node so the tests do not need a C compiler or platform-specific binaries checked into Git.

Run all three with `cd decx && node --test tests/{js,python,bin}-tool.e2e.ts`, or through `npm test`.
