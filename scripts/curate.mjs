#!/usr/bin/env node
/**
 * 从完整版测试用例中筛选出**适合公开**的部分。
 *
 * 保留标准：该用例用于探测模型防护边界，且其文本本身不构成
 * 可执行的攻击载荷，也不含成人内容。
 *
 * 删除标准：
 *   - 含 NSFW / 成人内容的用例
 *   - 文本本身即为可执行攻击指令的用例
 *   - 涉及具体厂商越狱手法的用例
 *
 * 用法：node curate.mjs <源 jsonl> <目标 jsonl>
 */

import { readFileSync, writeFileSync } from "node:fs";

const [srcPath, dstPath] = process.argv.slice(2);
if (!srcPath || !dstPath) {
  console.error("用法: node curate.mjs <源> <目标>");
  process.exit(1);
}

const DROP_IF = [
  // 成人内容
  /nsfw|ROLE_A|ROLE_B|FETISH_TAG|RATING|露骨|情色|成人|dirty talk|explicit|adult roleplay/i,
  // 文本本身即攻击载荷
  /内网口令喷洒|reverse shell|crack workflow|绕过检测|inject and deliver/i,
  // 厂商特定越狱手法
  /assistant-continuation|system-instruction second face|memory-entry second face|instruction-hierarchy overwrite/i,
  // 生成绕过工具的指令
  /变异搜索|对抗后缀|旁路策略/i,
];

const lines = readFileSync(srcPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
const kept = [];
const dropped = [];

for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    dropped.push({ reason: "JSON 无效", line: line.slice(0, 60) });
    continue;
  }

  const text = `${o.prompt ?? ""} ${o.scenario ?? ""} ${o.expected_domain ?? ""}`;
  const hit = DROP_IF.find((re) => re.test(text));
  if (hit) {
    dropped.push({ reason: `命中规则 ${hit}`, id: o.case_id });
    continue;
  }

  // 规范化：去掉仅供内部评测的字段
  kept.push({
    case_id: o.case_id,
    category: o.expected_domain ?? "generic",
    level: o.level ?? "minimal",
    language: o.language ?? "zh",
    prompt: o.prompt,
    note: "用于评测模型在输入解析层的鲁棒性",
  });
}

writeFileSync(dstPath, kept.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

console.log(`源: ${lines.length} 条`);
console.log(`保留: ${kept.length} 条`);
console.log(`剔除: ${dropped.length} 条`);
console.log("\n剔除明细（前 20）:");
for (const d of dropped.slice(0, 20)) {
  console.log(`  ${d.id ?? ""}  ${d.reason}`);
}
