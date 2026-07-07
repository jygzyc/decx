# DECX 安全分析报告

## 基本信息

| 字段 | 值 |
|---|---|
| 目标 | `{{target}}` |
| 范围 | `{{scope}}` |
| 会话 | `{{sessionName}}` |
| 分析日期 | `{{date}}` |

## 问题总览

| ID | 风险 | 标题 | 入口事实 | 影响事实 |
|---|---|---|---|---|
| `{{issue.id}}` | `{{issue.rating}}` | `{{issue.title}}` | `{{issue.entryFact}}` | `{{issue.impactFact}}` |

## {{issue.id}} {{issue.title}}

### 1. 目标情况

- 目标类型：`{{issue.targetKind}}`
- 入口：`{{issue.entry}}`
- 触发方式：`{{issue.trigger}}`
- 影响：`{{issue.impact}}`

### 2. 问题说明

- 可达性：`{{issue.reachability}}`
- 可控性：`{{issue.control}}`
- 保护/身份：`{{issue.guardOrIdentity}}`
- Sink：`{{issue.sink}}`
- 证据路径：`{{issue.evidencePath}}`

### 3. 组合链利用

`{{issue.composition}}`

### 4. 安全建议与修复

`{{issue.remediation}}`

## 残余 Open Intents

| Intent | Phase | Goal | Status |
|---|---|---|---|
| `{{intent.id}}` | `{{intent.phase}}` | `{{intent.goal}}` | `{{intent.status}}` |
