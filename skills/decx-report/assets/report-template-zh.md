# 模块安全分析报告

## 基本信息

| 字段 | 值 |
|------|-----|
| 目标 | `<analysis.meta.target>` |
| 范围 | `<analysis.context.scope>` |
| 会话 | `<analysis.meta.sessionName>` |
| Source ID | `<metadata.sourceId>` |
| Sink ID | `<metadata.sinkId>` |
| Flow | `<metadata.flowSig>` |
| Android / 设备 | `<analysis.meta.serial or N/A>` |
| 分析日期 | `YYYY-MM-DD` |

---

## 攻击面覆盖概览

| 指标 | 值 |
|------|-----|
| 总攻击面数量 | `<analysis.stats.total>` |
| `statically-supported` | `<analysis.stats.staticallySupported>` |
| `candidate` | `<analysis.stats.candidate>` |
| `rejected` | `<analysis.stats.rejected>` |
| 覆盖完成 | `<analysis.stats.complete>` |

> 概述覆盖是否完整，以及当前仍需证伪的重点攻击面。

---

## 问题一：[Risk] 漏洞标题

### 1. 漏洞分析

#### 背景

> 说明失效的安全边界、攻击者可控输入、可达入口和影响目标。

#### 完整调用链

> 从受害方组件入口、Binder Stub、或 manager facade 入口开始，到敏感 sink 结束。
> 攻击者动作只能写在“攻击路径”，不能写入这里。

```text
<victim.entryPoint>
  -> <source>
  -> <intermediate>
  -> <sink>
```

#### 代码分析

> 使用编号证据点，每个证据点都必须能支撑可达性、可控性、绕过条件或影响。

1. **入口可达**

```text
<evidence>
```

2. **缺少有效保护或保护可绕过**

```text
<evidence>
```

3. **到达敏感操作**

```text
<evidence>
```

#### 可绕过条件 / 不确定点

> 写明 guard、权限、身份检查、用户态条件中哪些已经证实可绕过，哪些仍是不确定点。

### 2. 攻击路径

#### 目标面

| 字段 | 值 |
|------|-----|
| Source ID | `<metadata.sourceId>` |
| Sink ID | `<metadata.sinkId>` |
| Flow | `<metadata.flowSig>` |
| 类型 / 服务 | `<target.context.type or serviceName>` |
| 入口 | `<finding.entryPoint>` |
| 权限 / 接口 | `<target.context.permission or interface>` |

#### 利用步骤

> 只写第三方攻击者现实可执行的动作。

1. `<step>`
2. `<step>`
3. `<step>`

### 3. 真实影响

> 写出可见、可验证的安全后果。

### 4. 风险定级依据

> 对照风险评级规则，解释为什么是当前等级。

### 5. 修复建议

> 给出入口保护、调用者身份校验、权限收敛、数据校验或 sink 前授权检查等可执行修复。

---

## 残余待证伪攻击面

| Source ID | Sink ID | Flow | 类型 / 服务 | 当前状态 | 仍缺失的证据 |
|-----------|---------|------|-------------|----------|--------------|
| `<sourceId>` | `<sinkId>` | `<flowSig>` | `<type>` | `candidate` | `<analysis.missingProof>` |
