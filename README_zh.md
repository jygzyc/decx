# DECX

通过统一的 **`decx` 入口**安装和运行逆向工具，配合可移植的 **Agent Skills**；另提供用于 Android Framework 收集和预处理的独立工具 **AFE（Android Framework Extract）**。

DECX 不实现反编译器，也不再提供统一命令包装层。直接使用各工具的原生接口：

| 任务 | 工具 |
| --- | --- |
| APK / DEX 分析 | [DroidASC](https://github.com/MG1937/ASC) |
| 原生二进制分析 | [Kuna](https://github.com/Noelo-Lab/kuna) |
| Android Framework 收集和预处理 | [AFE](third_party/afe/README.md) |
| 分析方法、漏洞证据、报告和 PoC | [执行 Skill](.agents/skills/decx-tool/) |

## 安装与管理工具

工具管理器位于 [`decx/`](decx/README.md)：通过 npm 分发的 Node CLI（需要 Node 24.21+，无运行时依赖，内嵌工具目录，每条数据命令输出一个 JSON 对象），用于安装上述工具并报告当前主机支持的能力。`5.0.0` 发布后可这样安装（在此之前 npm `latest` 仍是旧版 `4.3.0`）：

```bash
npm install -g @jygzyc/decx-cli
decx install kuna        # 下载该平台的上游 release 与编译好的 SLEIGH specs
decx install droidasc    # 创建私有 venv，直接从 PyPI pip install droidasc
decx install afe         # 下载匹配平台的 tools release；缺少资产时报错，不自动回退到 cargo 构建
decx -m kuna --help      # 直接运行工具本身，不翻译参数
decx help install        # 查看管理器或单个命令的用法
```

工具以不带版本的条目声明在中央目录 `third_party/tools.json` 中，根级必须为 `manifest: 1`，每个条目必须有 `id` 与 GitHub `repo: "owner/repo"`，不写代码。`requires` 必填，为 `bin`/`python`/`js`，必须匹配 `launch.type`；`env` 也必填，无环境变量时写 `{}`，不再隐式推导。归档安装逐页选择带齐主机主资产与额外资产的最新稳定 release，跳过无关发布、draft 与 prerelease。省略或 null `checksums` 时，每个下载必须有 GitHub REST SHA-256 摘要；显式校验文件与 tagPrefix 仍可配置。裸版本匹配列表中的 tag 与资产，不假定 `v`；完整 tag 可直接下载，但仍必须校验。可执行文件与载荷位于 `$DECX_HOME`（`bin/`、`share/<id>/`，其中 `PROVENANCE` 记录来源与校验值）；管理器只安装工具、不安装语言运行时，各工具保留自己的参数与输出。完整布局、`--links` 与安装规则见 [`decx/README.md`](decx/README.md)。

### 平台支持

管理器按主机平台选择要安装与执行的文件：`<os>-<arch>` 键（`win`/`darwin`/`linux` × `arm64`/`amd64`，如
`darwin-arm64`、`win-amd64`）
决定每个工具使用哪个 release asset，`decx -m <tool> …` 执行该平台解析出的程序与参数，调用方不自己挑二进制或路径。管理器通过 npm 分发单文件 JavaScript 包，运行时需要 Node，不再提供独立原生可执行文件。

安装、使用与构建均支持 macOS、Linux 与 Windows。npm CLI 可在 Windows 的 PowerShell / cmd 中直接运行，安装的工具使用 `.exe`/`.cmd` 名称；工具安装不依赖 Git Bash、`uname` 或 POSIX 工具。

| 工具 | macOS / Linux | Windows |
| --- | --- | --- |
| DroidASC | `$PREFIX/bin/droidasc` | `%PREFIX%\bin\droidasc.cmd`（转调 `%PREFIX%\runtime\droidasc\Scripts\droidasc.exe`） |
| Kuna | `bin/kuna`（转调 `share/kuna/bin/kuna` 的启动器）、`specs/` | `bin\kuna.cmd`（转调 `share\kuna\bin\kuna.exe` 的启动器）、`specs\` |
| AFE | `bin/afe` | `bin\afe.exe` |

各平台依赖：

- **DroidASC** — Python 3 与 `venv`；DECX 探测解释器，在私有环境内用 pip 安装 PyPI 包；最低 Python 版本由上游包元数据/pip 决定（目前 >=3.10）。
- **Kuna** — 安装上游 release（macOS/Linux arm64+x86_64、Windows x86_64），SLEIGH specs 为单独资产；生成的启动器导出 `KUNA_SPECS`。上游没有 Windows arm64 产物，`decx install kuna` 会直接报出来，而不是去编译参考用的源码。
- **AFE** — 安装匹配平台的预编译 GitHub Release 产物（由 DECX 自有的 `third_party/afe` 构建）；目前缺少对应资产时会报错，尚无 cargo 回退安装。ext4/EROFS/ZIP 由原生解析器处理，无需外部提取工具。

AFE 只产出文件：设备收集需要 ADB，不支持的文件系统特性会以明确错误失败，产物该用哪个分析器由调用方决定。详见 [AFE README](third_party/afe/README.md)。

## Skills

[`.agents/skills/`](.agents/skills/) 是纳入版本控制的唯一 skill 源目录。
[decx-tool](.agents/skills/decx-tool/) 通过 `decx <tool>` 或 `decx -m <tool>`
在已安装工具之间路由；各工具的原生命令、输出、错误与安装契约放在自己的
`references/` 文件中：`droidasc.md`、`kuna.md`（逐字复制上游 skill）和 `afe.md`。
[antifrida-bypass](.agents/skills/antifrida-bypass/) 是独立的执行 skill，
用于基于证据诊断和绕过 Android 原生层 anti-Frida 检测。

Skills 直接从仓库安装，独立于 CLI release，不作为 npm 包或 Release 资产发布。
不需要 Agent 专属扩展或知识维护运行时；安装、更新和卸载全部交给 `npx skills`，
DECX 不接管 skill 生命周期。在目标项目中执行：

```bash
# 安装到项目级 .agents/skills/
npx skills add jygzyc/decx --skill decx-tool --agent universal
npx skills add jygzyc/decx --skill antifrida-bypass --agent universal
# 更新已安装的 skills
npx skills update
# 卸载所选 skill
npx skills remove decx-tool --agent universal
npx skills remove antifrida-bypass --agent universal
```

安装 skill 不会安装 CLI 或分析工具。CLI 单独通过 npm 安装，
分析工具通过 `decx install <tool>` 安装。

```text
.agents/skills/
  decx-tool/
    SKILL.md
    references/
  antifrida-bypass/
    SKILL.md
    references/
    scripts/
```

## 开发验证

```bash
(cd third_party/afe && cargo build --release && cargo test)
npm --prefix decx ci && npm --prefix decx test
python3 scripts/check-skills.py
python3 -m unittest discover -s scripts -p 'test_check_skills.py'
```

各区域的完整门禁见 AGENTS.md §Validation。`.github/workflows/` 只保留 DECX 自有组件的流程：`decx-cli.yml`、`decx-afe.yml`、`decx-skills.yml`，各自用 `paths` 限定触发范围；分支和 PR 做检查，发布 tag 发布 npm CLI 和 AFE 产物。管理器与 crate 的门禁离线运行（fixture 压缩包、伪工具链与临时 prefix）。Actions 不获取第三方工具、不查询其 release、不自动更新源码 pin，也不编译 vendored 上游源码；CLI 直接读取 `third_party/tools.json`，解析匹配版本、下载上游发行包并强制校验 SHA-256。DroidASC 从 PyPI 安装到私有 venv，Kuna 从官方 release 安装二进制和 specs。

发布：`decx-v*` → 公开 npm 包 `@jygzyc/decx-cli`，必须先通过三平台检查并配置 npm trusted publishing；`tools-v*` → 六个平台的 `afe-v<version>-<platform>` 包 + `afe-SHA256SUMS.txt`。目录默认用 REST 摘要，校验文件仍供显式配置使用；旧 `afe-<version>` 归档不匹配新名称，必须发布匹配资产，不提供旧名称回退。DroidASC 与 Kuna 不需要本仓库打包发布；源码 pin 和原样复制的 Kuna skill 引用由显式维护更新。

真实分析检查保留为手动命令：先通过 CLI 安装工具到显式的临时 `DECX_HOME`，再运行 `npm --prefix decx run test:functional:kuna` 或 `npm --prefix decx run test:functional:droidasc`。缺少工具时会失败，不会静默跳过；这些检查不属于离线 CI。

## 范围与非目标

DECX 不提供分析 CLI、会话管理、分析器注册表、分析插件运行时、JADX 集成或分析服务端，也不把一个分析器的命令树翻译成另一个；`decx/` 只做安装、定位与报告，并把参数原样传给工具。DroidASC 与 Kuna 是按原样使用的上游工具。只有在上游工具确有无法覆盖的能力缺口时才增加适配。

`third_party/tools.json` 是唯一工具目录，工具 ID 不由源码路径推导。`third_party/afe/` 是 DECX 自己维护的 Rust 工具；`third_party/ASC`（MG1937/ASC）与 `third_party/kuna`（Noelo-Lab/kuna）直接作为固定版本的上游 git submodule（见 `.gitmodules`），保留上游 README 与许可证不变。工具契约仍在 `.agents/skills/decx-tool/references/`；源码布局和安装注意事项见 [third_party README](third_party/README.md)。

## 许可证

详见 [LICENSE](LICENSE)。DroidASC、Kuna 分别遵循其上游许可证，安装脚本不改变其许可条件。
