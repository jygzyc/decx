检查skill中是否存在如下问题，如存在，则进行简化或优化：

- 常识百科型：把常识类内容写入skill，浪费上下文空间
- 触发过宽型：不相关的场景也会加载该skill导致指令冲突
- 单文件大全型：skill长度高于200行，使大模型容易忽略中间内容
- 空壳包装型：skill内容只有去读另一个文件
- 互相冲突型：skill内容冲突

优化目标：

- 案例一：负面约束型（作用于维度三：压缩输出空间）

```
 Banned Patterns
 禁止使用 "In today's rapidly evolving landscape"
 禁止使用 "game-changer"、"cutting-edge"、"revolutionary"
 禁止无证据的模糊断言
 禁止在没有数据支撑时使用"显著提升"
```

- 案例二：决策路由型（作用于维度一：精准路由）

```
观察到的现象            优先测试方向     
 用户输入反射到HTML/JS   XSS / SSTI     
 服务端主动访问URL       SSRF           
 接收XML/Office/SVG     XXE            
 API中存在大量对象ID     IDOR / BOLA    
```

- 案例三：检查清单型（作用于维度三：约束 + 防遗忘）

```
Steps: Build → Type Check → Lint → Test → Security Scan → Diff Review

Output format:
Build:   [PASS/FAIL]
Types:   [PASS/FAIL] (X errors)
Lint:    [PASS/FAIL] (X warnings)
Tests:   [PASS/FAIL] (X/Y passed)
Security:[PASS/FAIL]
```

目标格式：

```
name: your-skill
description: What it does. Use when user asks to [specific trigger phrases].

 Instructions
 Step 1: [First Major Step]
 Step 2: [Second Major Step]

 Examples
 Example 1: [common scenario]

 Constraints
 [Hard rule 1]
 [Hard rule 2]

 Troubleshooting
 Error: [Common error message] → Solution: [fix]
```