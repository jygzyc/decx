# decx-droidasc — APK/DEX analysis (upstream DroidASC)

[DroidASC](https://github.com/MG1937/ASC) is published as `droidasc` on PyPI.
DECX installs the published package and its dependencies directly with pip,
inside a private Python virtual environment. No source packaging or tool-specific
installer script is needed.

| Path | Purpose |
| --- | --- |
| `decx-droidasc.json` | Declares `pip install droidasc`, the `droidasc` entry point and Python >=3.10. |
| `source/` | Vendored upstream git submodule for reference, not the install source. |
| `skills/decx-tool/references/droidasc.md` | Agent usage contract. |

```sh
decx install droidasc                       # latest published PyPI package
decx update droidasc --version 0.1.0        # select a published package version
decx droidasc --help                        # forward arguments to the installed command
```

DECX owns virtualenv creation and pip execution in
`$DECX_HOME/runtime/droidasc`; it writes `$DECX_HOME/share/droidasc/PROVENANCE`,
creates `$DECX_HOME/bin/droidasc` and links the command into `~/.local/bin`
(`.cmd` on Windows). The provenance records the installed package version,
Python interpreter and pip command. Python >=3.10 must already be on `PATH`;
DECX reports the missing runtime instead of installing Python itself.

`.github/workflows/decx-droidasc.yml` verifies a real PyPI installation and
runs the installed command on Linux, macOS and Windows. Manager unit tests
use a fake pip runner and never contact PyPI or the real home directory.
