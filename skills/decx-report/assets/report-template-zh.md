# DECX 安全分析报告

## 基本信息

| 字段 | 值 |
|---|---|
| 目标 | `{{target}}` |
| 范围 | `{{scope}}` |
| 会话 | `{{sessionName}}` |
| 分析日期 | `{{date}}` |

## 问题总览

| ID | 风险 | 标题 | 入口 | 影响 |
|---|---|---|---|---|
| `{{issue.id}}` | `{{issue.rating}}` | `{{issue.title}}` | `{{issue.entrypoint}}` | `{{issue.impact}}` |

## {{issue.id}} {{issue.title}}

### 1. 目标情况

- 目标：`{{issue.target}}`
- 入口：`{{issue.entrypoint}}`
- 触发方式：`{{issue.trigger}}`
- 影响：`{{issue.impact}}`

### 2. 问题说明

- 可达性：`{{issue.reachability}}`
- 可控性：`{{issue.control}}`
- 保护：`{{issue.guard}}`
- Sink：`{{issue.sink}}`
- 证据：`{{issue.evidence}}`

### 3. 组合链利用

- 结论：`{{issue.compositionVerdict}}`
- 详情：`{{issue.compositionDetail}}`

### 4. 安全建议与修复

`{{issue.remediation}}`
