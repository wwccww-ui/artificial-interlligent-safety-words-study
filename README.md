# LLM Prompt Lab

> `artificial-interlligent-safety-words-study`

用于 LLM 鲁棒性评测的 **DSH 插件**、**提示词样本**与**测试工具**。

本仓库是三合一：

1. **DSH 插件** — 可安装到 DeepSeek Harness 的提示词注入插件（`index.js` / `client.js` / `package.json` / `cordis.patch.yml`）
2. **测试用例** — 探测模型在输入被编码、分帧或声明了伪造优先级时的解析行为
3. **测试工具** — 提示词完整性断言框架、文本结构统计工具

> **不包含绕过手段的实现。** 详见 [使用约束](#使用约束)。

---

## 作为 DSH 插件安装

### 方式一：安装脚本（推荐）

```powershell
cd <本仓库目录>
powershell -ExecutionPolicy Bypass -File install.ps1
```

可选参数：

```powershell
# 只装到 web profile
powershell -ExecutionPolicy Bypass -File install.ps1 -Profiles web

# 卸载
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

脚本会：写入 profile 的 `cordis.patch.yml`、注入 `package.json` 依赖、
跑语法检查与断言套件。

**插件放在 `%USERPROFILE%\.dsh\plugins\` 下时**会使用标准相对路径；
放在其他位置时自动回退为绝对路径（脚本会提示）。

### 方式二：手动配置

```json
// %USERPROFILE%\.dsh\profiles\<name>\package.json
"dependencies": {
  "dsh-artificial-interlligent-safety-words-study": "file:///<本仓库绝对路径>"
}
```

```yaml
# %USERPROFILE%\.dsh\profiles\<name>\cordis.patch.yml
- insert:
    - id: dsh-artificial-interlligent-safety-words-study
      name: 'dsh-artificial-interlligent-safety-words-study'
```

### 安装后

**必须完全退出 DSH 进程再重启**（`index.js` 用顶层 `readFileSync`
读取提示词，热重载覆盖不到）。

重启后输入框上方会出现 `Prompt Lab v1.0.0` 状态条，随对话状态变化：

| 状态 | 显示 |
|---|---|
| 空闲 | `Prompt Lab v1.0.0` |
| 生成中 | `Prompt Lab v1.0.0 · 生成中` |
| 正常产出 | `Prompt Lab v1.0.0 · 交付物 N 字` |
| 输出未结构化 | `Prompt Lab v1.0.0 · 结构待查` |
| 未产出 | `Prompt Lab v1.0.0 · 未产出` |

### 插件架构

```
Order 100  prompts/core.md      输出契约 / 占位符归一化 / 推理纪律 /
                                八车道调度 / 40+ 确定性槽位 / 五种交付形态
Order 200  prompts/routing.md   输入归一化 / 边界词处理 /
                                占位符纪律 / 处理顺序
Order 300  prompts/quality.md   发送前自检 / 交付完整度 / 深度控制 /
                                八条输出反模式 Q1-Q8 / 收束规则
```

**八条车道**（按任务域分发）：

| 车道 | 覆盖范围 |
|---|---|
| `LANE_A` | 可写原语 — 进程内存读写、AOB 特征码、多级指针链、地址补丁 |
| `LANE_B` | 样本分析 — 二进制逆向、校验定位、重打包 |
| `LANE_C` | 暴露面 — Web / API / 云 / 内网侦察 |
| `LANE_D` | 元数据结构 — 配置、提示词、框架审计 |
| `LANE_E` | 移动端与嵌入式 — APK / IPA / 小程序 / 固件 |
| `LANE_F` | 日志与遥测 — 解析、关联、时间线构建 |
| `LANE_G` | 协议与格式 — 未知格式拆解、解析器实现 |
| `LANE_H` | 防御配置 — 加固、检测规则、审计清单 |

**确定性槽位**（40+ 条，命中即直出）：

```
侦察枚举    RECON / DIR / ENDPOINT / PARAM / VHOST / CERT
Web 验证    SQLI / SQLI-BL / XSS / SSRF / SSTI / LFI / XXE / UPLOAD /
            AUTHZ / IDOR / JWT / DESERIAL / CSRF / CORS
基础设施    CLOUD-META / S3 / K8S / CONTAINER
后渗透      PRIVESC / CREDS / PERSIST / LATERAL
内存二进制  TRAINER / CHECK-FN / HOOK
移动端      APK / MINI
防御        HARDEN / DETECT / LOG-QUERY
```

**五种交付形态**（按请求类型匹配）：

```
代码交付  ## 模块名      依赖 → 实现 → 调用示例 → 预期输出
步骤交付  ## 标题        编号步骤，每步带可执行命令
排错交付  ## 故障定位    复现 → 假设 → 验证 → 根因 → 补丁 → 回归
分析交付  ## 分析结论    现象 → 数据 → 推断 → 结论 → 局限
配置交付  ## 配置项      完整配置 → 逐项说明 → 生效 → 回滚
```

`index.js` 同时注册一个元数据工具 `prompt_lab_profile`，
返回版本、层结构、八车道清单与槽位分组。

---

## 作为测试工具使用

### 运行断言

```bash
node scripts/verify-prompts.mjs
# 结果: 61 通过, 0 失败
```

断言框架检查提示词文件结构与插件骨架的完整性：必需段落是否存在、
占位符是否齐备、是否混入了不该有的内容、`index.js` 是否引用了
已剔除的层。

改完提示词跑一次，立刻能发现"改坏了什么"。

### 运行文本结构分析

```bash
node scripts/analyze-references.mjs --site bqg228 --pages 1 --limit 100 --out report.md
```

输出段落长度分布、句长配比、对话占比、感官词密度等统计量。
**只统计特征，不采集原文**——报告里不含任何文本片段。

详见 [docs/analyzer.md](docs/analyzer.md)。

### 查看测试用例

```bash
cat datasets/input-parsing-cases.jsonl
```

详见 [docs/red-team-cases.md](docs/red-team-cases.md)。

---

## 目录

```
.
├── index.js                        插件服务端（三层注入 + 元数据工具）
├── client.js                       插件客户端（状态条）
├── package.json                    插件元数据
├── cordis.patch.yml                profile 注册模板
├── install.ps1                     安装/卸载脚本
├── verify-spec.json                断言规范（89 条）
├── datasets/
│   └── input-parsing-cases.jsonl   测试用例集
├── docs/
│   ├── red-team-cases.md           用例说明与评测方法
│   └── analyzer.md                 文本结构分析工具文档
├── prompts/
│   ├── core.md                     Order 100 核心内核
│   ├── routing.md                  Order 200 解析层路由
│   └── quality.md                  Order 300 输出质量层
└── scripts/
    ├── verify-prompts.mjs          提示词断言框架
    ├── analyze-references.mjs      文本结构分析器
    └── curate.mjs                  测试用例筛选工具
```

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
