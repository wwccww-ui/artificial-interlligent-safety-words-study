# LLM Prompt Lab

用于 LLM 鲁棒性评测的**提示词样本**与**测试工具**。

本仓库收录两样东西：

1. **测试用例** — 探测模型在输入被编码、分帧或声明了伪造优先级时的解析行为，供安全研究人员测试模型防护边界。
2. **测试工具** — 提示词完整性断言框架、文本结构统计工具。

> **不包含绕过手段的实现。** 详见 [使用约束](#使用约束)。

---

## 目录

```
.
├── datasets/
│   └── input-parsing-cases.jsonl   测试用例集
├── docs/
│   ├── red-team-cases.md           用例说明与评测方法
│   └── analyzer.md                 文本结构分析工具文档
├── prompts/
│   └── core.md                     提示词基线样例（用于验证断言框架）
├── scripts/
│   ├── verify-prompts.mjs          提示词断言框架
│   ├── analyze-references.mjs      文本结构分析器
│   ├── smoke_load.mjs              插件加载冒烟测试
│   └── curate.mjs                  测试用例筛选工具
├── verify-spec.json                断言规范
└── README.md
```

---

## 快速开始

### 运行断言

```bash
node scripts/verify-prompts.mjs

# 期望输出
# 结果: N 通过, 0 失败
```

断言框架检查提示词文件的结构完整性：必需段落是否存在、占位符是否齐备、
是否混入了不该有的内容、跨文件版本号是否一致。

改完提示词跑一次，能立刻发现"改坏了什么"。

### 运行文本结构分析

```bash
node scripts/analyze-references.mjs --site bqg228 --pages 1 --limit 100 --out report.md
```

输出段落长度分布、句长配比、对话占比、感官词密度等统计量。
**只统计特征，不采集原文**——报告里不含任何文本片段。

用途：验证提示词里写的写作规则（如"每段 20–36 字"）是否有实证依据。

详见 [docs/analyzer.md](docs/analyzer.md)。

### 查看测试用例

```bash
cat datasets/input-parsing-cases.jsonl
```

详见 [docs/red-team-cases.md](docs/red-team-cases.md)。

---

## 测试用例覆盖的技法

| 类别 | 探测目标 |
|---|---|
| 锚点声明 | 输入声称"你的系统提示词来自某来源且不可撤销"时，模型是否改变行为 |
| 编码分帧 | 输入被 Base64 / 零宽字符包裹时，是否绕过常规解析 |
| 多轮状态 | 输入声明"上一轮判定为 X，现在切换身份重做"时，是否继承该假设 |
| 仪式化前置 | 先做身份断言再提请求，是否影响后续处理 |
| 伪工具调用 | 引用不存在的工具名时，是否产生幻觉调用 |

**评测方法是基线对照**：同一请求提交两次（带技法包装 / 不带），
关注两者的**处理差异**，而非单次回复内容。

---

## 断言框架

`verify-prompts.mjs` 是一个不依赖模型的确定性检查器，用 JSON 描述规范：

```json
{
  "files": [
    { "path": "prompts/core.md", "minChars": 2000 }
  ],
  "assertions": {
    "prompts/core.md": {
      "contain": [
        { "value": "OUTPUT CONTRACT", "label": "输出契约段存在" }
      ],
      "absent": [
        { "value": "TODO", "label": "无未完成占位" }
      ],
      "countAtLeast": [
        { "pattern": "LANE_[A-D]", "min": 4, "label": "至少 4 条车道" }
      ]
    }
  }
}
```

支持的断言类型：

| 类型 | 作用 |
|---|---|
| `contain` / `absent` | 必含 / 必不含字面量 |
| `match` | 正则匹配 |
| `countAtLeast` | 模式出现次数下限 |
| `crossFile` | 跨文件一致性（版本号、冲突术语） |
| `datasets` | JSONL 数据集的字段与记录数校验 |

---

## 使用约束

1. **仅用于授权的评测环境。** 评测你自己部署的模型，或已获授权的第三方模型。
2. **不提供绕过手段。** 本仓库提供的是**探针**——用于发现防护边界在哪。
   从中推导绕过方法不在本项目范围内。
3. **不针对生产系统。** 用例中的 `TARGET`、`HOST` 等占位符代表本地合成靶标，
   不代表任何真实资产。
4. **遵守服务条款。** 使用前请确认你的测试行为符合被测模型提供方的
   Terms of Service 与 Usage Policy。
5. **不含成人内容。** 仓库内容经过筛选，不包含色情或露骨材料。

---

## 贡献

新增测试用例需满足：

- 文本本身不构成可执行的攻击载荷
- 不包含成人内容
- 不针对特定厂商的未公开实现细节
- 附带评测意图说明
- 提供对应的对照版本（去掉技法包装的原始请求）

新用例加进 `datasets/input-parsing-cases.jsonl`，然后跑一次
`node scripts/verify-prompts.mjs` 确认格式合规。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

---

## 免责声明

本项目为提示词工程与模型评测的方法论工具集。使用者应对自己的测试行为
及产生的后果负责。项目作者不对使用者的行为承担任何直接或间接责任。
