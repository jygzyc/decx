# DECX

使用原生工具进行逆向分析的 Agent skills，以及用于 Android Framework 收集和预处理的独立工具 **AFE（Android Framework Extract）**。

DECX 不实现反编译器，也不再提供统一命令包装层。直接使用各工具的原生接口：

| 任务 | 工具 |
| --- | --- |
| APK / DEX 分析 | [DroidASC](https://github.com/MG1937/ASC) |
| 原生二进制分析 | [Kuna](https://github.com/Noelo-Lab/kuna) |
| Android Framework 收集和预处理 | [AFE](third_party/decx-afe/README.md) |
| 分析方法、漏洞证据、报告和 PoC | [执行 Skill](skills/decx-tool/) |

## 安装与管理工具

工具管理器位于 [`decx/`](decx/README.md)：一个 Node CLI（Node 24.21+，直接执行 TypeScript 源码，无构建、无依赖，每条命令输出一个 JSON 对象），用于安装上述工具并报告当前主机支持的能力。

```bash
decx install kuna        # 下载该平台的上游 release 与编译好的 SLEIGH specs
decx install droidasc    # 创建私有 venv，直接从 PyPI pip install droidasc
decx install afe         # 下载匹配平台的 tools release；缺少资产时报错，不自动回退到 cargo 构建
decx -m kuna --help      # 直接运行工具本身，不翻译参数
decx help install        # 查看管理器或单个命令的用法
```

工具以数据形式声明在 `third_party/decx-<id>/decx-<id>.json` 中，不写代码。可执行文件与载荷位于 `$DECX_HOME`（`bin/`、`share/<id>/`，其中 `PROVENANCE` 记录来源与校验值）；管理器只安装工具、不安装语言运行时，各工具保留自己的参数与输出。完整布局、`--links` 与安装规则见 [`decx/README.md`](decx/README.md)。

### 平台支持

管理器按主机平台选择要安装与执行的文件：`<os>-<arch>` 键（`win`/`darwin`/`linux` × `arm64`/`amd64`，如
`darwin-arm64`、`win-amd64`）
决定每个工具用哪个 release asset（或源码构建），`decx -m <tool> …` 执行的就是该平台解析出的
启动器 —— 调用方从不自己挑二进制或路径。scriptc 0.2.7 直接编译完整管理器（`cd decx && npm run setup:scriptc && npm run build:scriptc && npm run test:native`），
原生可执行文件不依赖 Node；源码开发与 JavaScript 发行版仍需 Node。macOS arm64 的原生生命周期测试已在本地通过，CI 对 Linux x64/arm64、macOS arm64 与 Windows x64 设置同样的发布门槛。

安装、使用与编译均支持 macOS、Linux 与 Windows。管理器提供 Node CLI 与编译后的原生可执行文件，都可在 Windows 的 PowerShell / cmd 中直接运行并安装 `.exe`/`.cmd` 名称；工具安装不依赖 Git Bash、`uname` 或 POSIX 工具。

| 工具 | macOS / Linux | Windows |
| --- | --- | --- |
| DroidASC | `$PREFIX/bin/droidasc` | `%PREFIX%\bin\droidasc.cmd`（转调 `%PREFIX%\runtime\droidasc\Scripts\droidasc.exe`） |
| Kuna | `bin/kuna`（转调 `share/kuna/bin/kuna` 的启动器）、`specs/` | `bin\kuna.cmd`（转调 `share\kuna\bin\kuna.exe` 的启动器）、`specs\` |
| AFE | `bin/afe` | `bin\afe.exe` |

各平台依赖：

- **DroidASC** — Python >=3.10 与 `venv`；DECX 在私有虚拟环境内运行 pip 安装 PyPI 发布包及其依赖。
- **Kuna** — 安装上游 release（macOS/Linux arm64+x86_64、Windows x86_64），SLEIGH specs 为单独资产；生成的启动器导出 `KUNA_SPECS`。上游没有 Windows arm64 产物，`decx install kuna` 会直接报出来，而不是去编译参考用的源码。
- **AFE** — 安装匹配平台的预编译 GitHub Release 产物（由 `third_party/decx-afe` 构建）；目前缺少对应资产时会报错，尚无 cargo 回退安装。ext4/EROFS/ZIP 由原生解析器处理，无需外部提取工具。

AFE 只产出文件：设备收集需要 ADB，不支持的文件系统特性会以明确错误失败，产物该用哪个分析器由调用方决定。详见 [AFE README](third_party/decx-afe/README.md)。

## Skills

独立的工具路由 skill 是 [decx-tool](skills/decx-tool/)；[antifrida-bypass](skills/antifrida-bypass/) 是另一个可独立安装的执行 skill。decx-tool 负责在已安装的工具之间路由，每个工具自己的命令、输出与错误契约和安装方式放在各自的 `references/` 文件里——`droidasc.md`、`kuna.md`（上游官方 skill，逐字复制）和 `afe.md`。这些 skill 可在任意兼容 Agent Skills 的 harness 中独立驱动已安装的 DECX CLI，不需要 pi 扩展或源码仓库。管理器不安装 skills。在目标项目中用 `npx skills add jygzyc/decx --skill <skill-name>`（例如 `--skill decx-tool` 或 `--skill antifrida-bypass`）安装到项目级 `.agents/skills/`；skill 安装由 `npx skills` 负责，不由 DECX CLI 负责。

WikiSkill 的维护流程内化在 pi 扩展的命令和工具中，不再分发独立的 wiki skill。

下载 `decx-pi-<版本>.tar.gz` 并解压，先进入 `/path/to/decx-pi-<版本>/extensions/decx` 执行 `npm ci` 安装锁定的 `@openclaw/fs-safe` 依赖，再执行 `pi install /path/to/decx-pi-<版本>`；本地 pi 包不会自动安装依赖，无需 clone 源码。进入任意项目后执行 `/decx init`，在当前目录创建**空白** `.decxwiki/{raw,wiki}` 和空的 `.agents/skills/`，不下载或复制 skill；然后单独用 `npx skills` 安装 `decx-tool`。执行 `/decx-wiki` 由扩展整理执行记录、更新 wiki 并检查结构；通过 `decx_propose` / `decx_gate` 更新或回滚实际运行的 skill。旧知识仅保存在本地且被 Git 忽略的 `archive/legacy-knowledge/`，不会作为新项目的初始化内容。根目录 `skills/` 只保留当前可独立安装的执行 skill，不会被当作 wiki 工作区。

pi 扩展按推理、维护、提案阶段限制工具访问，并执行候选应用、分数门控和技能回滚。详见[工作流及读写约束边界](.pi/extensions/decx/README.md)。

```text
.decxwiki/                   # 当前项目中的知识工作区
  raw/traces/                # 不可变执行记录
  wiki/                      # 模式目录、维护日志、提案账本
    patterns/
    index.md
    logs.md
    skill-impact.md
.agents/skills/              # init 后为空；由 npx skills 安装所选 skill
```

pi 扩展独立安装，不复制到 `.decxwiki/`。

执行只读 skills、不读 wiki；维护者把 raw 记录沉淀到 wiki；提案者据此提出单个 skill 变更；验证决定是否保留，拒绝只回滚 skill、不回滚 wiki。导入的模式页属于引导知识，结构检查不等于验证分数。raw 默认进入 gitignore，因为可能包含目标数据；只应发布经过审阅的证据。

## 开发验证

```bash
cd third_party/decx-afe && cargo build --release && cargo test
cd decx && npm ci && npm test
npm ci --prefix .pi/extensions/decx
python3 skills/check-skills.py && node --test .pi/extensions/decx/*.test.ts
project=$(mktemp -d); node .pi/extensions/decx/cli.ts init --root "$project" && node .pi/extensions/decx/cli.ts check --root "$project"
```

各区域的完整门禁见 AGENTS.md §Validation；CI 按对象拆成 `.github/workflows/` 下的多个流程（`decx-cli.yml`、`decx-afe.yml`、`decx-droidasc.yml`、`decx-kuna.yml`），各自用 `paths` 限定触发范围。DroidASC 由上游发布到 PyPI，Kuna 从上游 GitHub Release 安装；本仓库只检查这两个工具的安装，管理器和 AFE 的流程负责发布。管理器与 crate 的门禁全部离线运行（fixture 压缩包、伪工具链与临时 prefix）；DroidASC 与 Kuna 两个流程会真实跑一遍安装路径，PR 流程不编译 vendored 的上游源码。发布：`decx-v*` → `decx-<version>.tar.gz` + `decx-SHA256SUMS.txt`，以及 `decx-pi-<version>.tar.gz` + `decx-pi-SHA256SUMS.txt`，`tools-v*` → 六个平台的 `afe-<version>-<platform>` 包 + `afe-SHA256SUMS.txt`。DroidASC 不需要本仓库打包源码。kuna 自动跟踪上游：其流程每 12 小时把 pin 的 tag 与上游最新 release 对比，没有更新就什么都不推送；有更新则移动 submodule pin、重新复制 skill 引用，并推送提交。`decx install kuna` 直接安装官方上游 `v*` release，通过 GitHub REST asset 的 SHA-256 摘要校验下载文件。

## 范围与非目标

DECX 不提供分析 CLI、会话管理、分析器注册表、分析插件运行时、JADX 集成或分析服务端，也不把一个分析器的命令树翻译成另一个；`decx/` 只做安装、定位与报告，并把参数原样传给工具。DroidASC 与 Kuna 是按原样使用的上游工具。只有在上游工具确有无法覆盖的能力缺口时才增加适配。

`third_party/` 存放所有子项目，每个子项目都是自包含的：自己的 `README.md`、它的工具契约（在 `skills/decx-tool/references/` 中）、以及管理器读取的工具清单 `decx-<id>.json`。`decx-afe/` 是 DECX 自己维护的 Rust 工具；`decx-droidasc/` 与 `decx-kuna/` 把上游源码作为固定版本的 git submodule 放在 `source/`（见 `.gitmodules`）。

## 许可证

详见 [LICENSE](LICENSE)。DroidASC、Kuna 分别遵循其上游许可证，安装脚本不改变其许可条件。
