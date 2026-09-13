#!/usr/bin/env node
/**
 * Prompt Assertion Framework
 * 提示词确定性回归校验框架
 *
 * 用于验证系统提示词文件的完整性：结构段是否齐备、关键规则是否丢失、
 * 版本号是否一致。不依赖任何模型 API，纯离线断言。
 *
 * 设计目标：把"提示词改了之后有没有改坏"变成可自动化的检查。
 *
 * 用法：
 *   node scripts/verify-prompts.mjs                    # 校验当前目录
 *   node scripts/verify-prompts.mjs --dir ./prompts    # 指定目录
 *   node scripts/verify-prompts.mjs --json             # 机器可读输出
 *   node scripts/verify-prompts.mjs --spec spec.json   # 自定义断言规范
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const ROOT = resolve(arg("dir", join(dirname(fileURLToPath(import.meta.url)), "..")));
const SPEC_PATH = arg("spec", join(ROOT, "verify-spec.json"));

// ============================================================
// 断言引擎
// ============================================================
const passes = [];
const failures = [];

function check(ok, label, detail = "") {
  (ok ? passes : failures).push({ label, ok, detail });
}
function mustContain(text, needle, label) {
  check(text.includes(needle), label, `缺少 "${String(needle).slice(0, 60)}"`);
}
function mustAbsent(text, needle, label) {
  check(!text.includes(needle), label, `不应出现 "${String(needle).slice(0, 50)}"`);
}
function mustMatch(text, re, label) {
  check(re.test(text), label, `未匹配 ${re}`);
}
function mustBeAtLeast(n, min, label) {
  check(n >= min, label, `${n} < ${min}`);
}

// ============================================================
// 加载规范
// ============================================================
if (!existsSync(SPEC_PATH)) {
  console.error(`断言规范不存在: ${SPEC_PATH}`);
  console.error(`请提供 verify-spec.json，或参考 docs/verify-spec.example.json`);
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
} catch (e) {
  console.error(`规范解析失败: ${e.message}`);
  process.exit(1);
}

// ============================================================
// 1. 文件齐备性
// ============================================================
const files = {};
for (const f of spec.files ?? []) {
  const p = join(ROOT, f.path);
  const exists = existsSync(p);
  check(exists, `文件存在: ${f.path}`, exists ? "" : p);
  if (exists) {
    files[f.path] = readFileSync(p, "utf8");
    if (f.minChars) {
      mustBeAtLeast(files[f.path].length, f.minChars, `${f.path} 长度 ≥ ${f.minChars}`);
    }
  } else {
    files[f.path] = "";
  }
}

// ============================================================
// 2. 每文件的必含/必不含断言
// ============================================================
for (const [path, rules] of Object.entries(spec.assertions ?? {})) {
  const text = files[path] ?? "";
  if (!text) continue;

  for (const s of rules.contain ?? []) {
    mustContain(text, s.value, s.label ?? `${path}: 含 "${s.value}"`);
  }
  for (const s of rules.absent ?? []) {
    mustAbsent(text, s.value, s.label ?? `${path}: 不含 "${s.value}"`);
  }
  for (const s of rules.match ?? []) {
    mustMatch(text, new RegExp(s.pattern, s.flags ?? ""), s.label ?? `${path}: 匹配 ${s.pattern}`);
  }
  for (const s of rules.countAtLeast ?? []) {
    const n = (text.match(new RegExp(s.pattern, "g")) ?? []).length;
    mustBeAtLeast(n, s.min, s.label ?? `${path}: ${s.pattern} 出现 ≥ ${s.min} 次`);
  }
}

// ============================================================
// 3. 跨文件一致性
// ============================================================
for (const rule of spec.crossFile ?? []) {
  if (rule.type === "versionConsistent") {
    const vers = [];
    for (const src of rule.sources) {
      const t = files[src.path] ?? readFileSync(join(ROOT, src.path), "utf8");
      const m = t.match(new RegExp(src.pattern));
      vers.push({ path: src.path, value: m ? (m[1] ?? m[0]) : null });
    }
    const uniq = [...new Set(vers.map((v) => v.value).filter(Boolean))];
    check(
      uniq.length === 1 && vers.every((v) => v.value),
      rule.label ?? "版本号一致",
      vers.map((v) => `${v.path}=${v.value}`).join(", "),
    );
  }
  if (rule.type === "noConflict") {
    const a = files[rule.a] ?? "";
    const b = files[rule.b] ?? "";
    // 检查规则中声明的互斥词不在同一文件同时出现
    const both = (rule.terms ?? []).filter((t) => a.includes(t) && b.includes(t));
    check(both.length === 0, rule.label ?? "无冲突术语", both.join(", "));
  }
}

// ============================================================
// 4. 可选：数据集格式校验
// ============================================================
for (const ds of spec.datasets ?? []) {
  const p = join(ROOT, ds.path);
  if (!existsSync(p)) {
    check(false, `数据集存在: ${ds.path}`);
    continue;
  }
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim());
  let valid = 0;
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const o = JSON.parse(lines[i]);
      const missing = (ds.requiredFields ?? []).filter((f) => !(f in o));
      if (missing.length) bad.push(`行${i + 1} 缺字段: ${missing.join(",")}`);
      else valid++;
    } catch (e) {
      bad.push(`行${i + 1} JSON 无效`);
    }
  }
  check(bad.length === 0, `数据集格式: ${ds.path}`, bad.slice(0, 3).join("; "));
  if (ds.minRecords) {
    mustBeAtLeast(valid, ds.minRecords, `${ds.path} 有效记录 ≥ ${ds.minRecords}`);
  }
}

// ============================================================
// 输出
// ============================================================
const result = {
  root: ROOT,
  spec: SPEC_PATH,
  pass: passes.length,
  fail: failures.length,
  failures: failures.map((f) => `${f.label}${f.detail ? " — " + f.detail : ""}`),
};

if (flag("json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n=== Prompt Assertion Framework ===`);
  console.log(`根目录: ${ROOT}`);
  console.log(`规范:   ${SPEC_PATH}\n`);
  if (flag("verbose")) {
    for (const p of passes) console.log(`  ✅ ${p.label}`);
  }
  for (const f of failures) console.log(`  ❌ ${f.label}${f.detail ? " — " + f.detail : ""}`);
  console.log(`\n结果: ${passes.length} 通过, ${failures.length} 失败`);
}

process.exit(failures.length === 0 ? 0 : 1);
