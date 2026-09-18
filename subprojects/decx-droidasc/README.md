# decx-droidasc — APK/DEX analysis (upstream DroidASC)

The subproject around [DroidASC](https://github.com/MG1937/ASC), an APK/DEX
analysis toolkit written in pure Python (no JVM). DECX vendors the upstream
checkout and installs it through the toolkit manager; the analysis itself is
upstream's, and its `--help` is the authority.

## In this repository

| Path | What it is |
| --- | --- |
| `decx-droidasc.json` | the toolkit manifest `decx` reads: install kind (`python-venv`), the pinned checkout, entry point, requirements, payload, launch and verify commands. The tool id is the directory name without the `decx-` prefix. |
| `skills/decx-droidasc/SKILL.md` | the agent skill that drives the installed launcher. |
| `source/` | the vendored upstream checkout, pinned as a git submodule (`git submodule status subprojects/decx-droidasc/source`). |

## Install

```sh
decx install droidasc        # private venv over the pinned checkout
decx run droidasc --help     # the tool's own interface, arguments untouched
```

The install copies upstream `main.py`, the `droidasc/` package and
`requirements.txt` into `$DECX_HOME/share/droidasc/`, builds a private venv there
with `pip install -r requirements.txt` (androguard 4.1.3), writes `PROVENANCE`,
and generates `$DECX_HOME/bin/droidasc` plus a `~/.local/bin` link (a `.cmd` shim
on Windows). The payload is self-contained: nothing is imported from the
checkout at run time, so a later `git submodule update` cannot change what the
installed launcher runs.

Python >= 3.10 must already be on `PATH`; the manager reports the shortfall
instead of installing an interpreter.

## Verify

```sh
decx install droidasc --home /tmp/decx-home --links /tmp/decx-links
/tmp/decx-home/share/droidasc/venv/bin/python -c 'import androguard; print(androguard.__version__)'
decx run --home /tmp/decx-home droidasc --help
```

Run that sequence after every pin move, on each platform, first checking the
pinned-checkout contract the manifest depends on: `main.py`, `requirements.txt`, the
`droidasc` package and `from droidasc import main`. It builds a venv and downloads
packages, so it stays a manual acceptance check — `.github/workflows/test.yml` runs
offline and never fetches a release.

## Upstream

- Repository: <https://github.com/MG1937/ASC> (Apache-2.0).
- Move the pin with `git -C subprojects/decx-droidasc/source checkout <rev>`
  and commit the subproject gitlink; re-run the acceptance sequence above before
  trusting the new revision.
- `source/` is upstream's code. DECX changes belong to this subproject — the
  manifest, the skill and this README — not to the checkout.
