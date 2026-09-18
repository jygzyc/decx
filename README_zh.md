# DECX

使用原生工具进行逆向分析的 Agent skills，以及用于 Android Framework 收集和预处理的独立工具 **AFE（Android Framework Extract）**。

DECX 不实现反编译器，也不再提供统一命令包装层。直接使用各工具的原生接口：

| 任务 | 工具 |
| --- | --- |
| APK / DEX 分析 | [DroidASC](https://github.com/MG1937/ASC) |
| 原生二进制分析 | [Kuna](https://github.com/Noelo-Lab/kuna) |
| Android Framework 收集和预处理 | [AFE](subprojects/decx-afe/README.md) |
| 分析方法、漏洞证据、报告和 PoC | [Skills](skills/) |

## 安装与管理工具

工具管理器位于 [`decx/`](decx/README.md)：一个 Node CLI（Node 22.18+，直接执行 TypeScript 源码，无构建、无依赖，每条命令输出一个 JSON 对象），用于安装上述工具并报告当前主机支持的能力。

```bash
decx install kuna        # 下载该平台的上游 release 与编译好的 SLEIGH specs
decx install droidasc    # 在固定版 submodule 上建立私有 venv
decx install afe         # 优先下载 tools release，否则用 cargo 构建 subprojects/decx-afe
decx run kuna --help     # 直接运行工具本身，不翻译参数
decx help install        # 查看管理器或单个命令的用法
```

工具以数据形式声明在 `subprojects/decx-<id>/decx-<id>.json` 中，不写代码。可执行文件与载荷位于 `$DECX_HOME`（`bin/`、`share/<id>/`，其中 `PROVENANCE` 记录来源与校验值）；管理器只安装工具、不安装语言运行时，各工具保留自己的参数与输出。完整布局、`--links` 与安装规则见 [`decx/README.md`](decx/README.md)。

### 平台支持

管理器按主机平台选择要安装与执行的文件：`<os>-<arch>` 键（如 `macos-arm64`、`windows-x64`）
决定每个工具用哪个 release asset（或源码构建），`decx run <tool> …` 执行的就是该平台解析出的
启动器 —— 调用方从不自己挑二进制或路径。

安装、使用与编译均支持 macOS、Linux 与 Windows。管理器是纯 Node，在 Windows 的 PowerShell / cmd 中直接运行，并安装 `.exe`/`.cmd` 名称；不依赖 Git Bash、`uname` 或 POSIX 工具。

| 工具 | macOS / Linux | Windows |
| --- | --- | --- |
| DroidASC | `$PREFIX/bin/droidasc` | `%PREFIX%\bin\droidasc.cmd`（转调 `%PREFIX%\share\droidasc\venv\Scripts\python.exe`） |
| Kuna | `bin/kuna`（转调 `share/kuna/bin/kuna` 的启动器）、`specs/` | `bin\kuna.cmd`（转调 `share\kuna\bin\kuna.exe` 的启动器）、`specs\` |
| AFE | `bin/afe` | `bin\afe.exe` |

各平台依赖：

- **DroidASC** — Python 3.11/3.12（64 位）及 `venv`；全部固定依赖都提供 `win_amd64` wheel，无需编译器。
- **Kuna** — 安装上游 release（macOS/Linux arm64+x86_64、Windows x86_64），SLEIGH specs 为单独资产；生成的启动器导出 `KUNA_SPECS`。上游没有 Windows arm64 产物，`decx install kuna` 会直接报出来，而不是去编译参考用的源码。
- **AFE** — 始终从本仓库（`subprojects/decx-afe`，Rust；Windows 上为 MSVC）构建。可选外部提取工具（`debugfs`、`fsck.erofs`、`extract.erofs`）没有 Windows 版本，因此 Windows 上始终使用内置的 ext4/EROFS/ZIP 解析器。

AFE 只产出文件：设备收集需要 ADB，不支持的文件系统特性可能回退到系统工具，产物该用哪个分析器由调用方决定。详见 [AFE README](subprojects/decx-afe/README.md)。

## Skills

仓库中的 [skills](skills/) 按“一个暴露面一个 skill、一个工具一个 skill”组织：`decx-init`、`decx-vulnhunt`、`decx-report`、`decx-poc` 是流程 skill，`decx-droidasc`、`decx-kuna`、`decx-afe` 各自驱动一个已安装的工具，并自带该工具的安装、运行与错误契约。把 harness 指向 `skills/` 即可。管理器不安装 skills。

Decx 遵循 [WikiSkill](https://arxiv.org/html/2608.27454) §3：共享工作区是三个**平级**层，而不是每个 skill 各带一个 wiki。

```text
raw/                         # 不可变执行记录（默认不发布）
  traces/                    # 每次 session 一条不可变记录
wiki/
  index.md                   # 共享模式目录
  patterns/                  # 经验沉淀，不是执行指令
  logs.md                    # 维护日志（保持初始状态；仅 log: true 时追写）
  skill-impact.md            # 提案账本（保持初始状态；仅 decx_propose 写入）
skills/
  <name>/
    SKILL.md                 # 完整执行流程
    PURPOSE.md               # 仅维护者使用的模式映射
    references/              # 可选的可执行参考材料
.pi/extensions/decx/     # pi 集成，不属于三个知识层
```

执行只读 skills、不读 wiki；维护者把 raw 记录沉淀到 wiki；提案者据此提出单个 skill 变更；验证决定是否保留，拒绝只回滚 skill、不回滚 wiki。导入的模式页属于引导知识，结构检查不等于验证分数。raw 默认进入 gitignore，因为可能包含目标数据；只应发布经过审阅的证据。

## 开发验证

```bash
cd subprojects/decx-afe && cargo build --release && cargo test
cd decx && npm ci && npm test
python3 skills/check-skills.py && node --test .pi/extensions/decx/lib.test.ts && node .pi/extensions/decx/cli.ts check
```

各区域的完整门禁见 AGENTS.md §Validation；CI 按对象拆成 `.github/workflows/` 下的多个流程（`decx-cli.yml`、`decx-afe.yml`、`decx-droidasc.yml`、`decx-kuna.yml`），各自用 `paths` 限定触发范围。管理器与 crate 的门禁全部离线运行（fixture 压缩包、伪工具链与临时 prefix）；DroidASC 与 Kuna 两个流程会真实跑一遍安装路径，PR 流程不编译 vendored 的上游源码。发布按对象各有一个流程：`release-cli.yml`（`decx-v*` → `decx-<version>.tar.gz` + `decx-SHA256SUMS.txt`）、`release-afe.yml`（`tools-v*` → 六个平台的 `afe-<version>-<platform>` 包 + `afe-SHA256SUMS.txt`）、`release-kuna.yml`（`kuna-v*` → 优先镜像上游 release 资产并统一重打包为 zip，仅在上游拉不到时才从 pin 的源码构建上游五个目标 + 编译 specs）、`release-droidasc.yml`（`droidasc-v*` → pin 源码 tarball）。kuna 与 droidasc 的产物就是 manifest 里 `fallbackRelease` 指向的回退源；上游 release 始终是首选安装源。

## 范围与非目标

DECX 不提供分析 CLI、会话管理、分析器注册表、内嵌 JavaScript 运行时、JADX 集成或分析服务端，也不把一个分析器的命令树翻译成另一个；`decx/` 只做安装、定位与报告，并把参数原样传给工具。DroidASC 与 Kuna 是按原样使用的上游工具。只有在上游工具确有无法覆盖的能力缺口时才增加适配。

`subprojects/` 存放所有子项目，每个子项目都是自包含的：自己的 `README.md`、驱动它的 skill（在 `skills/` 下）、以及管理器读取的工具清单 `decx-<id>.json`。`decx-afe/` 是 DECX 自己维护的 Rust 工具；`decx-droidasc/` 与 `decx-kuna/` 把上游源码作为固定版本的 git submodule 放在 `source/`（见 `.gitmodules`）。

## 许可证

详见 [LICENSE](LICENSE)。DroidASC、Kuna 分别遵循其上游许可证，安装脚本不改变其许可条件。
