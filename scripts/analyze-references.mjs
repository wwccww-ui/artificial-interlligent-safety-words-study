#!/usr/bin/env node
/**
 * 参考作品结构分析器 (reference-structure-analyzer)
 *
 * 用途：抓取在线小说的**结构特征**，输出统计报告。
 *
 * 设计原则：
 *   1. 只统计，不落盘原文 —— 分析完即丢弃正文，报告里不含任何原文片段
 *      （--show-snippets 可显式开启短句样例，默认关闭）
 *   2. 目标是提炼可写进提示词的**方法论**，不是搬运样本
 *   3. 全部离线确定性计算，无外部依赖，无需 API Key
 *
 * 用法：
 *   node scripts/analyze-references.mjs
 *   node scripts/analyze-references.mjs --pages 5 --limit 60
 *   node scripts/analyze-references.mjs --out report.md
 *   node scripts/analyze-references.mjs --urls urls.txt
 *   node scripts/analyze-references.mjs --show-snippets
 */

import { writeFileSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

// ============================================================
// 站点适配器
// ============================================================
// 每个站点结构不同，用适配器抽象三件事：
//   listUrl(page)  → 列表页 URL
//   bookHrefs(html)→ 从列表页提取书籍/章节入口
//   chapters(html) → 从书籍目录页提取章节 URL
//   body(html)     → 提取正文纯文本（处理各站的反爬）
//
// 反爬形态实测：
//   alicesw  : 直接 HTML，容器 class=j_readContent
//   xbiqugew : 正文 Base64 藏在 qsbs.bb('...')，需解码；且有 _1 _2 分页

const ADAPTERS = {
  alicesw: {
    label: "爱丽丝书屋",
    base: "https://xn--vcsx64d.als6.sbs",
    listUrl: (p) =>
      p === 1 ? "/all/order/update_time+desc.html" : `/all/order/update_time+desc.html?page=${p}`,
    bookHrefs: (h) => [...new Set([...h.matchAll(/href="(\/book\/\d+\/[a-z0-9]+\.html)"/g)].map((m) => m[1]))],
    chapters: null, // 列表页直接给章节链接
    paginate: () => [],
    body: (h) => {
      const m = h.match(/<div[^>]*class="[^"]*j_readContent[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      return m ? m[1] : null;
    },
    blocked: (h) => (h.length < 3000 && /cute-alert|访问异常/.test(h) ? "限流页" : null),
  },

  xbiqugew: {
    label: "笔趣阁(新)",
    base: "https://www.xbiqugew.com",
    listUrl: (p) => (p === 1 ? "/" : `/list/${p}.html`),
    bookHrefs: (h) => [...new Set([...h.matchAll(/href="(\/\d+_\d+\/?)"/g)].map((m) => m[1]))],
    chapters: (h) => [...new Set([...h.matchAll(/href="(\/\d+\/\d+\/\d+\.html)"/g)].map((m) => m[1]))],
    // 正文分页：{id}.html → {id}_1.html → {id}_2.html ...
    paginate: (url) => {
      const m = url.match(/^(.*?)(\d+)\.html$/);
      if (!m) return [url];
      return [url, `${m[1]}${m[2]}_1.html`, `${m[1]}${m[2]}_2.html`, `${m[1]}${m[2]}_3.html`];
    },
    // 正文有两种形态（实测同一站内混用）：
    //   A) Base64 藏在多次 qsbs.bb('...') 调用里
    //   B) 明文 <p> 标签直接放在 div.word_read 内
    body: (h) => {
      const calls = [...h.matchAll(/qsbs\.bb\('([A-Za-z0-9+/=]+)'\)/g)];
      if (calls.length) {
        let s = "";
        for (const c of calls) {
          try { s += Buffer.from(c[1], "base64").toString("utf8"); } catch { /* 跳过坏块 */ }
        }
        if (s.trim()) return s;
      }
      // 回退：明文容器
      const m = h.match(/<div[^>]*class="[^"]*word_read[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div/i)
             || h.match(/<div[^>]*class="[^"]*word_read[^"]*"[^>]*>([\s\S]*)<\/div>/i);
      return m ? m[1] : null;
    },
    blocked: (h) => (h.length < 500 ? "空页/拦截" : null),
  },

  bqg228: {
    label: "笔趣阁228",
    base: "https://www.bqg228.com",
    // 列表页为 /book/N/，目录页章节为 /book/N/M.html
    listUrl: (p) => (p === 1 ? "/" : `/list/${p}.html`),
    bookHrefs: (h) => [...new Set([...h.matchAll(/href="(\/book\/\d+\/?)"/g)].map((m) => m[1]))],
    // 只取本书章节（排除 /fenlei/ 分类链接与 mulu 分页）
    chapters: (h) => {
      const m = h.match(/href="(\/book\/(\d+)\/)"/);
      if (!m) return [];
      const id = m[2];
      return [...new Set([...h.matchAll(new RegExp(`href="(/book/${id}/\\d+\\.html)"`, "g"))].map((x) => x[1]))];
    },
    paginate: (url) => {
      // 章节正文分页：{id}.html → {id}_1.html → {id}_2.html ...
      // 实测单页仅 550–1000 汉字，需合并分页才够 MIN_CHARS
      const m = url.match(/^(.*?)(\d+)\.html$/);
      if (!m) return [url];
      return [url, `${m[1]}${m[2]}_1.html`, `${m[1]}${m[2]}_2.html`, `${m[1]}${m[2]}_3.html`];
    },
    // 正文全部 Base64 藏在 qsbs.bb('...') 里；无壳页机制（实测 12/12 完整）
    body: (h) => {
      const calls = [...h.matchAll(/qsbs\.bb\('([A-Za-z0-9+/=]+)'\)/g)];
      if (!calls.length) return null;
      let s = "";
      for (const c of calls) {
        try { s += Buffer.from(c[1], "base64").toString("utf8"); } catch { /* 跳过坏块 */ }
      }
      return s || null;
    },
    blocked: (h) => (h.length < 500 ? "空页/拦截" : null),
  },
};

const DEFAULT_SITE = "xbiqugew";

// ============================================================
// 配置
// ============================================================

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const SITE_KEY = arg("site", DEFAULT_SITE);
const ADAPTER = ADAPTERS[SITE_KEY];
if (!ADAPTER) {
  console.error(`未知站点: ${SITE_KEY}`);
  console.error(`可用: ${Object.keys(ADAPTERS).join(", ")}`);
  process.exit(1);
}

const BASE = arg("base", ADAPTER.base).replace(/\/$/, "");
const PAGES = Number(arg("pages", 3));
const LIMIT = Number(arg("limit", 40));
const OUT = arg("out", "");
const URLS_FILE = arg("urls", "");
const SHOW_SNIPPETS = flag("show-snippets");
const DELAY_MS = Number(arg("delay", 350));
const MIN_CHARS = Number(arg("min-chars", 800));

// ============================================================
// HTTP（Node 内置 https，避免依赖）
// ============================================================

const fetchText = (url) =>
  new Promise((resolve, reject) => {
    const getter = url.startsWith("https") ? httpsGet : httpGet;
    const req = getter(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchText(new URL(res.headers.location, url).href).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.setTimeout(25000, () => req.destroy(new Error("timeout")));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// HTML 清洗
// ============================================================

const stripTags = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/h\d>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&middot;/g, "·")
    .replace(/\u3000/g, " ");

/**
 * 限流/拦截页识别。
 * 站点用「访问异常，请稍后再试，请于 <时间> 后再试」做限流，
 * 返回 200 + 极短 HTML，如果不识别会被当成"无正文"静默丢弃，
 * 导致样本数虚高（前面 38/80 失败就是这么来的）。
 */
function detectBlock(html) {
  const siteVerdict = ADAPTER.blocked ? ADAPTER.blocked(html) : null;
  if (siteVerdict) return siteVerdict;
  if (html.length > 3000) return null;
  const m = html.match(/请于\s*([\d\-:\s]+?)\s*后再试/);
  if (m) return `限流（解除时间 ${m[1]}）`;
  if (/访问异常|访问频繁|请稍后再试/.test(html)) return "限流（未给出解除时间）";
  if (/<title>\s*提示信息\s*<\/title>/.test(html)) return "拦截页";
  return null;
}

// 站点尾部噪音（各站通用的免责/导航残留）
const NOISE_RE =
  /^(爱丽丝书屋|Copyright|本站|声明：|请记住|天才一秒|笔趣阁|上一章|下一章|章节目录|保存书签|加入书签|推荐票|投推荐|（本章完）|手机版|返回目录)/;

/** 提取正文；返回段落数组。只取正文容器，不取导航/评论/推荐。 */
function extractBody(html) {
  // 壳页识别：某些站对大量章节返回"请勿开启阅读模式"占位页，
  // 正文只有一两句提示。必须丢弃，否则会污染统计（实测曾导致
  // 对话占比被算成 0.0%）。
  if (/请勿开启浏览器阅读模式|章节内容缺失/.test(html)) return null;

  const raw = ADAPTER.body(html);
  if (!raw) return null;

  const text = stripTags(raw);
  const paras = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => !NOISE_RE.test(p))
    // 过滤超短噪音行（页码、装饰符等）
    .filter((p) => cnLen(p) > 2);
  return paras.length ? paras : null;
}

// ============================================================
// 特征分析
// ============================================================

/** 中文按字计数（忽略空白与标点） */
const cnLen = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/** 段落切分：按中文标点断句，用于句长统计 */
const splitSentences = (text) =>
  text
    .split(/(?<=[。！？…])\s*/)
    .map((s) => s.trim())
    .filter((s) => cnLen(s) > 0);

const DIALOGUE_RE = /[""「」『』"']|—|--/;

// 对话行占比：整段是否以对话为主
// 用 \u 转义而非字面量，避免编辑器/管道处理时把中文引号损坏成 ASCII 引号
const QUOTE_CHARS = /[\u201c\u201d\u300c\u300d\u300e\u300f"]/;
const QUOTE_OPEN = /^[\u201c\u300c\u300e"]/;

const isDialoguePara = (p) => {
  const marks = (p.match(new RegExp(QUOTE_CHARS.source, "g")) || []).length;
  return marks >= 2 || QUOTE_OPEN.test(p);
};

// 感官词表（用于密度统计，不采集原文）
const SENSE = {
  视觉: /视|看|望|盯|瞥|目光|眼|光|亮|暗|影|颜色|红|白|青|灰|轮廓|模糊|清晰/g,
  触觉: /触摸|摩挲|抚|按|压|攥|握|抓|扣|贴|抵|滑|烫|热|凉|冷|软|硬|紧|湿|黏|麻|颤/g,
  听觉: /听|声|响|音|哼|喘|呻吟|呼吸|静|吵|嗡|咚|啪|吱|哗/g,
  嗅觉: /闻|味|香|臭|腥|气息|气味|甜|苦/g,
  体感: /累|软|晕|酸|胀|抖|绷|沉|轻|痛|痒|窒息|心跳|呼吸/g,
};

const countMatches = (text, re) => (text.match(new RegExp(re.source, re.flags.replace("g", "") + "g")) || []).length;

/** 分析单篇 */
function analyzeChapter(paras) {
  const full = paras.join("\n");
  const totalChars = cnLen(full);
  if (totalChars === 0) return null;

  const paraLens = paras.map(cnLen).filter((n) => n > 0);
  const sentences = splitSentences(full);
  const sentLens = sentences.map(cnLen).filter((n) => n > 0);

  const dialogueParas = paras.filter(isDialoguePara).length;

  const senses = {};
  for (const [k, re] of Object.entries(SENSE)) {
    senses[k] = (countMatches(full, re) / totalChars) * 1000; // 每千字
  }

  // 段落开头类型（判断"是否直接进入场景"）
  const first = paras[0] || "";
  const opensWithDialogue = isDialoguePara(first);
  const opensWithScene = /[，。]/.test(first) && cnLen(first) > 15;

  return {
    totalChars,
    paraCount: paraLens.length,
    paraAvg: avg(paraLens),
    paraMedian: median(paraLens),
    paraMin: Math.min(...paraLens),
    paraMax: Math.max(...paraLens),
    sentCount: sentLens.length,
    sentAvg: avg(sentLens),
    sentMedian: median(sentLens),
    shortSentRatio: sentLens.filter((n) => n <= 10).length / sentLens.length,
    longSentRatio: sentLens.filter((n) => n >= 30).length / sentLens.length,
    dialogueParaRatio: dialogueParas / paras.length,
    senses,
    opensWithDialogue,
    opensWithScene,
  };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "-");

// ============================================================
// 采集
// ============================================================

async function collectUrls() {
  if (URLS_FILE) {
    return readFileSync(URLS_FILE, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => (l.startsWith("http") ? l : BASE + (l.startsWith("/") ? l : "/" + l)));
  }

  const urls = new Set();

  // 情况一：列表页直接给章节链接（如 alicesw）
  if (!ADAPTER.chapters) {
    for (let p = 1; p <= PAGES; p++) {
      const u = BASE + ADAPTER.listUrl(p);
      try {
        const html = await fetchText(u);
        const found = ADAPTER.bookHrefs(html);
        found.forEach((x) => urls.add(x.startsWith("http") ? x : BASE + x));
        process.stderr.write(`  列表页 ${p}: +${found.length} 章\n`);
      } catch (e) {
        process.stderr.write(`  列表页 ${p}: 失败 ${e.message}\n`);
      }
      await sleep(DELAY_MS);
    }
    return [...urls].slice(0, LIMIT);
  }

  // 情况二：列表页给书籍入口，需再进目录页取章节（如 xbiqugew / bqg228）
  const bookSet = new Set();
  for (let p = 1; p <= PAGES; p++) {
    const u = BASE + ADAPTER.listUrl(p);
    try {
      const html = await fetchText(u);
      const found = ADAPTER.bookHrefs(html);
      found.forEach((x) => bookSet.add(x.startsWith("http") ? x : BASE + x));
      process.stderr.write(`  列表页 ${p}: +${found.length} 本书\n`);
    } catch (e) {
      process.stderr.write(`  列表页 ${p}: 失败 ${e.message}\n`);
    }
    await sleep(DELAY_MS);
  }

  const books = [...bookSet];
  process.stderr.write(`  共 ${books.length} 本书，进入目录页取章节...\n`);

  // 每本书只取前若干章，避免单本书占满整个样本池
  // （实测某些站的列表页会给出大量指向同一目录的镜像条目）
  const PER_BOOK = Math.max(3, Math.ceil(LIMIT / Math.max(1, books.length)));
  for (const b of books) {
    if (urls.size >= LIMIT) break;
    try {
      const html = await fetchText(b);
      const found = ADAPTER.chapters(html);
      // 取中段章节，避开首章前言/完结感言等非正文内容
      const start = found.length > PER_BOOK * 2 ? Math.floor(found.length * 0.3) : 0;
      const slice = found.slice(start, start + PER_BOOK);
      slice.forEach((x) => urls.add(x.startsWith("http") ? x : BASE + x));
    } catch { /* 目录页失败跳过 */ }
    await sleep(DELAY_MS);
  }

  return [...urls].slice(0, LIMIT);
}

/** 抓一章正文：处理分页，返回合并后的段落数组 */
async function fetchChapter(url) {
  const pages = ADAPTER.paginate ? ADAPTER.paginate(url) : [url];
  const chunks = [];
  for (const p of pages) {
    let html;
    try {
      html = await fetchText(p);
    } catch {
      break;
    }
    if (!html || html.length < 500) break;
    const paras = extractBody(html);
    if (!paras || !paras.length) break;
    chunks.push(...paras);
    if (pages.length > 1) await sleep(Math.min(DELAY_MS, 300));
  }
  return chunks.length ? chunks : null;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  process.stderr.write(`\n=== 参考作品结构分析 ===\n`);
  process.stderr.write(`站点: ${ADAPTER.label} (${SITE_KEY})  ${BASE}\n`);
  process.stderr.write(`列表页数: ${PAGES}  上限: ${LIMIT} 章  间隔: ${DELAY_MS}ms\n\n`);

  const urls = await collectUrls();
  process.stderr.write(`\n待分析: ${urls.length} 章\n\n`);

  const results = [];
  let ok = 0, fail = 0, blocked = 0;
  let blockReason = null;

  for (let i = 0; i < urls.length; i++) {
    try {
      // 限流检测：用首章页探测，命中即中止
      const probe = await fetchText(urls[i]);
      const b = detectBlock(probe);
      if (b) {
        blocked++;
        blockReason = b;
        process.stderr.write(`\n  [限流] ${b}\n  已中止采集（已完成 ${ok} 章有效样本）\n`);
        break;
      }

      const paras = await fetchChapter(urls[i]);
      if (!paras || !paras.length) { fail++; continue; }
      const stats = analyzeChapter(paras);
      if (!stats || stats.totalChars < MIN_CHARS) { fail++; continue; }
      results.push(stats);
      ok++;
      if ((i + 1) % 10 === 0) process.stderr.write(`  已处理 ${i + 1}/${urls.length}\n`);
    } catch (e) {
      // 超时/连接错误也算失败，但不中止
      fail++;
    }
    await sleep(DELAY_MS);
  }

  process.stderr.write(
    `\n完成: 成功 ${ok} / 失败 ${fail}${blocked ? ` / 限流中断 ${blocked}` : ""}\n\n`,
  );

  if (!results.length) {
    console.error(
      blockReason
        ? `采集被限流中止（${blockReason}）。请等待后重试，或降低频率：--delay 1500`
        : "没有采集到有效样本。",
    );
    process.exit(1);
  }
  if (results.length < 10) {
    process.stderr.write(
      `[警告] 有效样本仅 ${results.length} 章，统计置信度不足。建议 ≥30 章。\n\n`,
    );
  }

  // ---- 汇总 ----
  const sum = (arr, f) => avg(results.map(f));
  const col = (f) => results.map(f).filter((n) => Number.isFinite(n));

  const paraLens = results.map((r) => r.paraAvg);
  const sentLens = results.map((r) => r.sentAvg);

  const senseAvg = {};
  for (const k of Object.keys(SENSE)) {
    senseAvg[k] = avg(results.map((r) => r.senses[k]));
  }

  const charCounts = results.map((r) => r.totalChars);

  const L = [];
  const w = (s = "") => L.push(s);

  w(`# 参考作品结构特征报告`);
  w();
  w(`> 本报告仅为**统计特征**，不含任何原文内容。`);
  w(`> 样本：${ok} 章（失败 ${fail}${blocked ? `，限流中断 ${blocked}` : ""}）`);
  w(`> 站点：${BASE}`);
  w(`> 生成：${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
  if (blockReason) {
    w(`>`);
    w(`> ⚠ **采集中途被限流**（${blockReason}），样本量可能不足。`);
    w(`> 建议等待解除后重跑，并提高间隔：\`--delay 1500\``);
  }
  if (results.length < 30) {
    w(`>`);
    w(`> ⚠ 有效样本 ${results.length} 章 < 30，统计置信度有限，结论仅供参考。`);
  }
  w();
  w(`## 一、篇幅`);
  w();
  w(`| 指标 | 均值 | 中位 | P10 | P90 |`);
  w(`|---|---|---|---|---|`);
  w(`| 单章字数（汉字） | ${f1(avg(charCounts))} | ${f1(median(charCounts))} | ${f1(pct(charCounts, 0.1))} | ${f1(pct(charCounts, 0.9))} |`);
  w(`| 段落数 | ${f1(sum(results, (r) => r.paraCount))} | - | - | - |`);
  w();
  w(`## 二、段落`);
  w();
  w(`| 指标 | 均值 | 中位 |`);
  w(`|---|---|---|`);
  w(`| 段均字数 | ${f1(avg(paraLens))} | ${f1(median(paraLens))} |`);
  w();
  const allParaAvg = avg(results.map((r) => r.paraAvg));
  w(`段落长度分布（跨样本汇总）：`);
  w();
  w(`- 短段（≤40 字）主导：${allParaAvg < 80 ? "是——节奏偏快，适合对话与动作" : "否——段落偏长，叙述密度高"}`);
  w(`- 建议提示词区间：**${Math.round(allParaAvg * 0.7)}–${Math.round(allParaAvg * 1.3)} 字/段**`);
  w();
  w(`## 三、句子`);
  w();
  w(`| 指标 | 值 |`);
  w(`|---|---|`);
  w(`| 句均字数 | ${f1(avg(sentLens))} |`);
  w(`| 短句占比（≤10 字） | ${f1(avg(results.map((r) => r.shortSentRatio)) * 100)}% |`);
  w(`| 长句占比（≥30 字） | ${f1(avg(results.map((r) => r.longSentRatio)) * 100)}% |`);
  w();
  w(`## 四、对话占比`);
  w();
  w(`| 指标 | 值 |`);
  w(`|---|---|`);
  w(`| 对话性段落占比 | ${f1(avg(results.map((r) => r.dialogueParaRatio)) * 100)}% |`);
  w(`| 开篇为对话的比例 | ${f1((results.filter((r) => r.opensWithDialogue).length / results.length) * 100)}% |`);
  w(`| 开篇为场景描写的比例 | ${f1((results.filter((r) => r.opensWithScene).length / results.length) * 100)}% |`);
  w();
  w(`## 五、感官词密度（每千汉字）`);
  w();
  w(`| 通道 | 密度 |`);
  w(`|---|---|`);
  for (const [k, v] of Object.entries(senseAvg).sort((a, b) => b[1] - a[1])) {
    w(`| ${k} | ${f1(v)} |`);
  }
  w();
  const top = Object.entries(senseAvg).sort((a, b) => b[1] - a[1]);
  w(`主导通道：**${top[0][0]}**（${f1(top[0][1])}/千字）　最弱：**${top[top.length - 1][0]}**（${f1(top[top.length - 1][1])}/千字）`);
  w();
  w(`---`);
  w();
  w(`## 六、可提炼为提示词的结论`);
  w();
  w(`以下为**方法论**，可直接改写为规则：`);
  w();
  w(`1. **段落长度**：参考样本段均 ${f1(avg(paraLens))} 字。`);
  w(`   建议在提示词中给定区间下限与上限，避免整段概述或碎句堆叠。`);
  w();
  w(`2. **句长配比**：短句 ${f1(avg(results.map((r) => r.shortSentRatio)) * 100)}% / 长句 ${f1(avg(results.map((r) => r.longSentRatio)) * 100)}%。`);
  w(`   短句主导说明节奏靠断句控制，而非靠形容词堆叠。`);
  w();
  w(`3. **对话占比**：${f1(avg(results.map((r) => r.dialogueParaRatio)) * 100)}%。`);
  w(avg(results.map((r) => r.dialogueParaRatio)) > 0.3
    ? `   对话占比高，说明推进主要靠台词而非叙述，提示词应强调对话工艺。`
    : `   对话占比中等，叙述与对话并重，提示词应同时约束两层。`);
  w();
  w(`4. **开篇方式**：${f1((results.filter((r) => r.opensWithDialogue || r.opensWithScene).length / results.length) * 100)}% 的样本首段即进入场景或对话，`);
  w(`   无背景铺陈。可据此强化"开篇即入"规则。`);
  w();
  w(`5. **感官分布**：主导通道为 ${top[0][0]}。`);
  w(`   提示词应要求每拍至少两种感官，并给出各通道的具体词汇，`);
  w(`   避免整段只有单一通道。`);
  w();
  w(`---`);
  w();
  w(`## 附：数据来源说明`);
  w();
  w(`- 本报告由 \`scripts/analyze-references.mjs\` 生成。`);
  w(`- **不采集、不存储、不分发任何原文内容**，仅统计结构指标。`);
  w(`- 参考站点的作品版权归原权利人所有，本站点自述为网友收集整理、非盈利性质。`);
  w(`- 本工具用于提炼写作方法论，不用于内容再分发。`);

  if (SHOW_SNIPPETS) {
    w();
    w(`## 附：样例片段（--show-snippets 已开启）`);
    w();
    w(`（本段默认关闭；开启时仅输出极短片段用于人工判断，不参与统计）`);
  }

  const report = L.join("\n");

  if (OUT) {
    writeFileSync(OUT, report, "utf8");
    process.stderr.write(`报告已写入: ${OUT}\n`);
  } else {
    console.log(report);
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
