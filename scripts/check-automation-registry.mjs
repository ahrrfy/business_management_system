#!/usr/bin/env node
/**
 * حارِسُ **سجلّ الأتمتة** (برنامج v2، §٣ «الأتمتة أوّلاً»).
 *
 * ## العلّة التي وُجد لها
 * الزرُّ الزائد لا يُكلّف شاشةً: يُكلّف **قراراً يوميّاً** على موظّفٍ لا يملك ما يقرّره به.
 * ولا يظهر في أيّ فحصٍ ولا اختبار — الخدمةُ تعمل والشاشةُ تعرض والموظّفُ وحده يدفع الثمن.
 * فالسجلّ [`shared/automationRegistry.ts`](../shared/automationRegistry.ts) يُجبر كلّ انتقالِ
 * حالةٍ على إعلان طبيعته: `AUTO` بدليلٍ **مُسمّى**، أو `MANUAL` بمبرّرٍ **مكتوب**. وهذا
 * الحارسُ يمنع السجلَّ من الشيخوخة بصمت.
 *
 * ## ما يقيسه بالضبط (ستّة كواشف، كلٌّ يُثبَّت في `--selftest`)
 *  · `A1` مفتاحٌ لا يُركَّب من القاموسَين: كيانٌ مجهول، أو حالةٌ ليست في `WORK_ORDER_STATUSES`
 *         /`INVOICE_STATUSES`، أو انتقالٌ إلى الحالة نفسها.
 *  · `A2` انتقالٌ **تُصرّح به القواميس** وليس في السجلّ: كلّ زوجٍ في `WO_NEXT_STATUS`، وكلّ
 *         حالةٍ في `DEAD_INVOICE_STATUSES` يجب أن تكون هدفاً لمفتاحٍ واحدٍ على الأقل.
 *  · `A3` حالةٌ في قاموسٍ لا يذكرها أيُّ مفتاح — إلّا أن يُبرَّر غيابُها في
 *         `STATES_WITHOUT_TRANSITIONS` بنصٍّ لا يقلّ عن `MIN_JUSTIFICATION_LENGTH`.
 *  · `A4` `MANUAL` بلا `because` أو بنصٍّ أقصرَ من `MIN_JUSTIFICATION_LENGTH`.
 *  · `A5` `AUTO` بلا `evidence` أو بنصٍّ أقصرَ من `MIN_JUSTIFICATION_LENGTH`.
 *  · `A6` خلطُ الحقل بالنوع: `AUTO` يحمل `because`، أو `MANUAL` يحمل `evidence`.
 *
 * ## ⛔ ما لا يقيسه — بصراحةٍ تامّة
 *  · **لا يحكم على جودة النصّ.** أنّ `because` ليس إعادةَ صياغةٍ لاسم الانتقال («يدويّ لأنّه
 *    يدويّ») حكمٌ لا يقيسه عدّادُ محارف. الطولُ مقياسُ **وجود** لا جودة، ومَن يريد الجودة
 *    فمكانُها المراجعةُ البشريّة. حارسٌ يدّعي ما لا يفعله يُنذر كذباً فيُتجاوَز فيصير مسرحياً.
 *  · **لا يستخرج الرسمَ البيانيّ الحقيقيّ للانتقالات من الخدمات.** لا قاموسَ يُصرّح به، واستخراجُه
 *    نصّياً من `server/services/**` يُنتج إنذاراتٍ كاذبةً بالجملة (كلُّ `status: "X"` في اختبارٍ
 *    أو بذرةٍ أو جدولٍ آخر). ⇒ انتقالٌ حقيقيٌّ في خدمةٍ غيرُ مُسجَّلٍ هنا **يمرّ** ما لم يُدخِل
 *    حالةً جديدة أو زوجاً في `WO_NEXT_STATUS`. هذه حدودُ الحارس، لا تُبنَ عليه ثقةٌ أوسع.
 *  · **لا يتحقّق أنّ ما سُجّل `AUTO` منفَّذٌ آلياً فعلاً** في الشيفرة — تعاقدُ نيّةٍ لا تعاقدُ تنفيذ.
 *  · **ولا يُغطّي غير الكيانَين** أمرِ الشغل وفاتورةِ البيع (`ENTITIES` أدناه).
 *
 * ## ويفشل **مغلقاً** عند تعذّر التحليل
 * حارسٌ يمرّ صامتاً حين لا يفهم مُدخَله أسوأُ من غيابه: يمنح ثقةً ويأخذ انتباهاً. فإن عاد
 * أيُّ تحليلٍ فارغاً (قائمةُ حالات، خريطةُ التقدّم، مداخلُ السجلّ، الثابتُ العدديّ) خرج بـ1.
 *
 * الاستعمال:
 *   node scripts/check-automation-registry.mjs
 *   node scripts/check-automation-registry.mjs --selftest
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SELFTEST_ONLY = process.argv.slice(2).includes("--selftest");

/** الكيانات المُغطّاة ومصدرُ حالات كلٍّ منها. إضافةُ كيانٍ تُعدَّل هنا وفي السجلّ معاً. */
const ENTITIES = {
  workOrder: { file: "shared/workOrderStatus.ts", array: "WORK_ORDER_STATUSES" },
  invoice: { file: "shared/invoiceStatus.ts", array: "INVOICE_STATUSES" },
};
const REGISTRY_FILE = "shared/automationRegistry.ts";

/** مفتاحُ انتقالٍ: `كيان:من->إلى`. */
const KEY_RE = /"([A-Za-z][A-Za-z0-9]*):([A-Z][A-Z0-9_]*)->([A-Z][A-Z0-9_]*)"\s*:\s*\{/g;
/** مفتاحُ حالةٍ مُبرَّرِ الغياب: `كيان:حالة` — بلا `->` فلا يلتبس بالسابق. */
const EXCUSE_RE = /"([A-Za-z][A-Za-z0-9]*):([A-Z][A-Z0-9_]*)"\s*:\s*("(?:[^"\\]|\\.)*")/g;

// ───────────────────────────── أدوات التحليل ─────────────────────────────

/**
 * يحذف التعليقات ويُبقي السلاسل. ⭐ لازمٌ لأنّ رأسَ السجلّ نفسه يحوي `{ kind: "AUTO"; … }`
 * في تعليقٍ توضيحيّ — ماسحُ الأقواس بلا تجريدٍ يبتلعه فينحرف عن مداخل السجلّ الحقيقية.
 * ⛔ ولا يقصّ `//` داخل سلسلة (رابطٌ في نصٍّ عربيّ) وإلّا حُذف نصُّ تبريرٍ حقيقيّ.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * يقرأ الكتلة `{…}` المتوازنة ابتداءً من قوسٍ مفتوحٍ عند `open`، مُحترِماً السلاسل.
 * يُرجع `null` إن لم تُغلَق — تحليلٌ فاشلٌ يُعلَن ولا يُخمَّن.
 */
export function readBalanced(src, open) {
  if (src[open] !== "{") return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** `export const NAME = ["A", "B"] as const;` ⇒ `["A","B"]`. */
export function parseStringArray(src, name) {
  const m = new RegExp(`\\b${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(stripComments(src));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * موضعُ القوس المفتوح لجسم `const NAME … = { … }`.
 *
 * ⚠️ **ولا يُبحَث عن أوّل `{` بعد الاسم**: أنواعُ القوالب النصّيّة تحوي `${…}` — فـ
 * `Partial<Record<\`invoice:${InvoiceStatus}\`, string>>` يجعل أوّلَ قوسٍ بعد الاسم قوسَ
 * الاستيفاء لا قوسَ الجسم، فيعود التحليلُ فارغاً و**يُنذر الحارسُ كذباً** على ملفٍّ سليم.
 * (أمسكناها على `STATES_WITHOUT_TRANSITIONS` نفسها.) ⇒ المرساةُ علامةُ الإسناد `= {`.
 */
export function findAssignedBrace(clean, name) {
  const at = clean.indexOf(name);
  if (at < 0) return -1;
  const rest = clean.slice(at);
  const m = /=\s*\{/.exec(rest);
  if (!m) return -1;
  return at + m.index + m[0].length - 1;
}

/** `export const WO_NEXT_STATUS: … = { RECEIVED: "IN_PROGRESS", … };` ⇒ أزواج. */
export function parseArrowMap(src, name) {
  const clean = stripComments(src);
  const open = findAssignedBrace(clean, name);
  if (open < 0) return [];
  const body = readBalanced(clean, open);
  if (body == null) return [];
  return [...body.matchAll(/([A-Z][A-Z0-9_]*)\s*:\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => [
    m[1],
    m[2],
  ]);
}

/**
 * مداخلُ السجلّ. المدخلُ يُقرأ ككتلةٍ متوازنة ثمّ تُستخرج حقولُه — لا كنمطٍ واحدٍ يشترط
 * وجودَ الحقل: نمطٌ كهذا **يُسقِط المدخل الناقص بصمت** وهو بالضبط ما نُريد الإمساك به.
 */
export function parseRegistryEntries(src) {
  const clean = stripComments(src);
  const out = [];
  for (const m of clean.matchAll(KEY_RE)) {
    const open = m.index + m[0].length - 1;
    const body = readBalanced(clean, open);
    if (body == null) {
      out.push({ key: `${m[1]}:${m[2]}->${m[3]}`, entity: m[1], from: m[2], to: m[3], unparsed: true });
      continue;
    }
    const kind = /\bkind\s*:\s*"(AUTO|MANUAL)"/.exec(body);
    const because = /\bbecause\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    const evidence = /\bevidence\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    out.push({
      key: `${m[1]}:${m[2]}->${m[3]}`,
      entity: m[1],
      from: m[2],
      to: m[3],
      kind: kind ? kind[1] : null,
      because: because ? because[1] : null,
      evidence: evidence ? evidence[1] : null,
    });
  }
  return out;
}

/** `STATES_WITHOUT_TRANSITIONS` ⇒ `{ "invoice:CONFIRMED": "…" }`. */
export function parseExcuses(src, name = "STATES_WITHOUT_TRANSITIONS") {
  const clean = stripComments(src);
  const open = findAssignedBrace(clean, name);
  if (open < 0) return {};
  const body = readBalanced(clean, open);
  if (body == null) return {};
  const out = {};
  for (const m of body.matchAll(EXCUSE_RE)) out[`${m[1]}:${m[2]}`] = JSON.parse(m[3]);
  return out;
}

/** `export const MIN_JUSTIFICATION_LENGTH = 20;` ⇒ `20`، أو `null` إن غاب. */
export function parseMinLength(src) {
  const m = /MIN_JUSTIFICATION_LENGTH\s*=\s*(\d+)/.exec(stripComments(src));
  return m ? Number(m[1]) : null;
}

// ───────────────────────────── الكواشف ─────────────────────────────

/**
 * @param {{statuses: Record<string,string[]>, declaredForward: [string,string,string][],
 *          deadTargets: [string,string][], entries: any[], excuses: Record<string,string>,
 *          minLen: number}} input
 */
export function findViolations({ statuses, declaredForward, deadTargets, entries, excuses, minLen }) {
  const v = [];
  const keys = new Set(entries.map((e) => e.key));

  // A1 — مفتاحٌ لا يُركَّب من القاموسَين.
  for (const e of entries) {
    if (e.unparsed) {
      v.push({ code: "A1", key: e.key, msg: "تعذّر قراءة كتلة المدخل (قوسٌ غير مغلق؟)" });
      continue;
    }
    const known = statuses[e.entity];
    if (!known) {
      v.push({ code: "A1", key: e.key, msg: `كيانٌ غير مُغطّى: «${e.entity}»` });
      continue;
    }
    if (!known.includes(e.from))
      v.push({ code: "A1", key: e.key, msg: `«${e.from}» ليست في قاموس ${e.entity}` });
    if (!known.includes(e.to))
      v.push({ code: "A1", key: e.key, msg: `«${e.to}» ليست في قاموس ${e.entity}` });
    if (e.from === e.to)
      v.push({ code: "A1", key: e.key, msg: "الطرفان متطابقان — ليس انتقالاً" });
  }

  // A2 — انتقالٌ تُصرّح به القواميس وليس في السجلّ.
  for (const [entity, from, to] of declaredForward) {
    const key = `${entity}:${from}->${to}`;
    if (!keys.has(key))
      v.push({ code: "A2", key, msg: "انتقالٌ مُصرَّحٌ به في القاموس بلا مدخلٍ في السجلّ" });
  }
  for (const [entity, state] of deadTargets) {
    const reached = entries.some((e) => e.entity === entity && e.to === state);
    if (!reached)
      v.push({
        code: "A2",
        key: `${entity}:*->${state}`,
        msg: "حالةٌ نهائيّة في القاموس لا يبلغها أيُّ انتقالٍ مُسجَّل",
      });
  }

  // A3 — حالةٌ لا يذكرها أيُّ مفتاح ولا مُبرَّرٌ غيابُها.
  const seen = new Set();
  for (const e of entries) {
    seen.add(`${e.entity}:${e.from}`);
    seen.add(`${e.entity}:${e.to}`);
  }
  for (const [entity, list] of Object.entries(statuses)) {
    for (const state of list) {
      const id = `${entity}:${state}`;
      if (seen.has(id)) continue;
      const excuse = excuses[id];
      if (excuse != null && excuse.trim().length >= minLen) continue;
      v.push({
        code: "A3",
        key: id,
        msg:
          excuse == null
            ? "حالةٌ في القاموس بلا انتقالٍ مُسجَّل ولا تبريرٍ في STATES_WITHOUT_TRANSITIONS"
            : `تبريرُ الغياب أقصرُ من ${minLen} محرفاً`,
      });
    }
  }

  // A4/A5/A6 — عقدُ المحتوى.
  for (const e of entries) {
    if (e.unparsed) continue;
    if (e.kind == null) {
      v.push({ code: "A6", key: e.key, msg: "مدخلٌ بلا `kind`" });
      continue;
    }
    if (e.kind === "MANUAL") {
      if (e.because == null)
        v.push({ code: "A4", key: e.key, msg: "`MANUAL` بلا `because` — المبرّر إلزاميّ" });
      else if (e.because.trim().length < minLen)
        v.push({
          code: "A4",
          key: e.key,
          msg: `مبرّرٌ أقصرُ من ${minLen} محرفاً (${e.because.trim().length})`,
        });
      if (e.evidence != null)
        v.push({ code: "A6", key: e.key, msg: "`MANUAL` يحمل `evidence` — خلطُ حقلٍ بنوع" });
    } else {
      if (e.evidence == null)
        v.push({ code: "A5", key: e.key, msg: "`AUTO` بلا `evidence` — الدليل إلزاميّ" });
      else if (e.evidence.trim().length < minLen)
        v.push({
          code: "A5",
          key: e.key,
          msg: `دليلٌ أقصرُ من ${minLen} محرفاً (${e.evidence.trim().length}) — لا يُسمّي مصدراً`,
        });
      if (e.because != null)
        v.push({ code: "A6", key: e.key, msg: "`AUTO` يحمل `because` — خلطُ حقلٍ بنوع" });
    }
  }

  return v;
}

// ───────────────────────────── الاختبار الذاتيّ ─────────────────────────────

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) fails.push(`${name}\n      المتوقَّع: ${w}\n      الناتج : ${g}`);
  };
  const codes = (input) => [...new Set(findViolations(input).map((x) => x.code))].sort();

  // ── أدوات التحليل ──
  eq("تجريدُ تعليقٍ سطريّ", stripComments('const a = 1; // تعليق\nconst b = 2;'), "const a = 1; \nconst b = 2;");
  eq(
    "⛔ ولا يقصّ `//` داخل سلسلة",
    stripComments('const u = "a//b"; // تعليق'),
    'const u = "a//b"; ',
  );
  eq("تجريدُ كتلةٍ", stripComments("const a = 1; /* { kind: x } */ const b = 2;"), "const a = 1;  const b = 2;");

  eq(
    "قراءةُ مصفوفةِ حالات",
    parseStringArray('export const S = [\n  "A",\n  "B",\n] as const;', "S"),
    ["A", "B"],
  );
  eq("⛔ ومصفوفةٌ غائبة ⇒ فارغة (يُعلَن لا يُخمَّن)", parseStringArray("export const X = 1;", "S"), []);

  eq(
    "قراءةُ خريطة التقدّم",
    parseArrowMap('export const M: Partial<X> = { A: "B", C: "D" };', "M"),
    [["A", "B"], ["C", "D"]],
  );

  eq(
    "قوسٌ متوازنٌ يحترم السلاسل",
    readBalanced('{ a: "}", b: 1 }', 0),
    '{ a: "}", b: 1 }',
  );
  eq("⛔ وقوسٌ غير مغلق ⇒ null", readBalanced('{ a: 1', 0), null);

  eq("قراءةُ الثابت العدديّ", parseMinLength("export const MIN_JUSTIFICATION_LENGTH = 20;"), 20);
  eq("⛔ وغيابُه ⇒ null", parseMinLength("export const X = 1;"), null);

  eq(
    "قراءةُ مبرّرات الغياب",
    parseExcuses('export const STATES_WITHOUT_TRANSITIONS: T = {\n  "invoice:CONFIRMED": "نصٌّ",\n};'),
    { "invoice:CONFIRMED": "نصٌّ" },
  );
  // ⭐ الفخُّ الحقيقيّ الذي أنذر كذباً على الملفّ السليم: `${…}` في نوعِ قالبٍ نصّيّ يسبق
  // قوسَ الجسم. المرساةُ `= {` تتجاوزه — وبدونها يعود التحليلُ فارغاً ويشتعل A3 زوراً.
  eq(
    "⭐ لا يبتلع `${…}` في نوعِ قالبٍ نصّيّ قبل الجسم",
    parseExcuses(
      "export const STATES_WITHOUT_TRANSITIONS: Partial<\n  Record<`invoice:${InvoiceStatus}`, string>\n> = {\n  \"invoice:CONFIRMED\": \"نصٌّ\",\n};",
    ),
    { "invoice:CONFIRMED": "نصٌّ" },
  );

  {
    const src = `export const R: T = {
      "workOrder:A->B": { kind: "MANUAL", because: "س" },
      "invoice:C->D": { kind: "AUTO", evidence: "ص" },
      "invoice:E->F": { kind: "MANUAL" },
    };`;
    eq(
      "⭐ المدخلُ الناقص يُقرأ ولا يُسقَط",
      parseRegistryEntries(src).map((e) => [e.key, e.kind, e.because, e.evidence]),
      [
        ["workOrder:A->B", "MANUAL", "س", null],
        ["invoice:C->D", "AUTO", null, "ص"],
        ["invoice:E->F", "MANUAL", null, null],
      ],
    );
  }

  // ── الكواشف: لكلٍّ حالةٌ موجبةٌ وأخرى سالبة ──
  const base = {
    statuses: { workOrder: ["X", "Y"], invoice: ["P", "Q"] },
    declaredForward: [["workOrder", "X", "Y"]],
    deadTargets: [["invoice", "Q"]],
    excuses: {},
    minLen: 20,
  };
  const LONG_M = "مبرّرٌ بشريٌّ حقيقيٌّ يتجاوز الحدّ الأدنى بوضوحٍ تامّ";
  const LONG_E = "دليلٌ مُسمّى: حقلُ paidAmount في جدول الفواتير بعد كلّ إيصال";
  const clean = {
    ...base,
    entries: [
      { key: "workOrder:X->Y", entity: "workOrder", from: "X", to: "Y", kind: "MANUAL", because: LONG_M, evidence: null },
      { key: "invoice:P->Q", entity: "invoice", from: "P", to: "Q", kind: "AUTO", because: null, evidence: LONG_E },
    ],
  };
  eq("✓ سجلٌّ سليمٌ ⇒ صفرُ مخالفات", codes(clean), []);

  eq(
    "A1 يمسك حالةً ليست في القاموس",
    codes({
      ...clean,
      entries: [
        ...clean.entries,
        { key: "workOrder:X->ZZ", entity: "workOrder", from: "X", to: "ZZ", kind: "MANUAL", because: LONG_M, evidence: null },
      ],
    }),
    ["A1"],
  );
  eq(
    "A1 يمسك كياناً مجهولاً",
    codes({
      ...clean,
      entries: [
        ...clean.entries,
        { key: "purchase:X->Y", entity: "purchase", from: "X", to: "Y", kind: "MANUAL", because: LONG_M, evidence: null },
      ],
    }),
    ["A1"],
  );
  eq(
    "A1 يمسك الطرفَين المتطابقَين",
    codes({
      ...clean,
      entries: [
        ...clean.entries,
        { key: "workOrder:X->X", entity: "workOrder", from: "X", to: "X", kind: "MANUAL", because: LONG_M, evidence: null },
      ],
    }),
    ["A1"],
  );

  eq(
    "A2 يمسك زوجَ WO_NEXT_STATUS الغائب",
    codes({ ...clean, declaredForward: [["workOrder", "X", "Y"], ["workOrder", "Y", "X"]] }),
    ["A2"],
  );
  eq(
    "A2 يمسك حالةً نهائيّةً لا يبلغها انتقال",
    codes({ ...clean, deadTargets: [["invoice", "Q"], ["invoice", "P"]] }),
    ["A2"],
  );

  eq(
    "A3 يمسك حالةً غيرَ مذكورةٍ ولا مُبرَّرة",
    codes({ ...clean, statuses: { workOrder: ["X", "Y", "W"], invoice: ["P", "Q"] } }),
    ["A3"],
  );
  eq(
    "⛔ A3 لا يُنذر حين يُبرَّر الغيابُ بنصٍّ كافٍ",
    codes({
      ...clean,
      statuses: { workOrder: ["X", "Y", "W"], invoice: ["P", "Q"] },
      excuses: { "workOrder:W": LONG_M },
    }),
    [],
  );
  eq(
    "A3 يُنذر حين يكون التبريرُ أقصرَ من الحدّ",
    codes({
      ...clean,
      statuses: { workOrder: ["X", "Y", "W"], invoice: ["P", "Q"] },
      excuses: { "workOrder:W": "قصير" },
    }),
    ["A3"],
  );

  eq(
    "A4 يمسك MANUAL بلا because",
    codes({
      ...clean,
      entries: [
        { key: "workOrder:X->Y", entity: "workOrder", from: "X", to: "Y", kind: "MANUAL", because: null, evidence: null },
        clean.entries[1],
      ],
    }),
    ["A4"],
  );
  eq(
    "A4 يمسك because أقصرَ من الحدّ",
    codes({
      ...clean,
      entries: [
        { key: "workOrder:X->Y", entity: "workOrder", from: "X", to: "Y", kind: "MANUAL", because: "يدويّ", evidence: null },
        clean.entries[1],
      ],
    }),
    ["A4"],
  );

  eq(
    "A5 يمسك AUTO بلا evidence",
    codes({
      ...clean,
      entries: [
        clean.entries[0],
        { key: "invoice:P->Q", entity: "invoice", from: "P", to: "Q", kind: "AUTO", because: null, evidence: null },
      ],
    }),
    ["A5"],
  );
  eq(
    "A5 يمسك evidence أقصرَ من الحدّ",
    codes({
      ...clean,
      entries: [
        clean.entries[0],
        { key: "invoice:P->Q", entity: "invoice", from: "P", to: "Q", kind: "AUTO", because: null, evidence: "واضح" },
      ],
    }),
    ["A5"],
  );

  eq(
    "A6 يمسك خلطَ الحقل بالنوع",
    codes({
      ...clean,
      entries: [
        clean.entries[0],
        { key: "invoice:P->Q", entity: "invoice", from: "P", to: "Q", kind: "AUTO", because: LONG_M, evidence: LONG_E },
      ],
    }),
    ["A6"],
  );
  eq(
    "A6 يمسك مدخلاً بلا kind",
    codes({
      ...clean,
      entries: [
        clean.entries[0],
        { key: "invoice:P->Q", entity: "invoice", from: "P", to: "Q", kind: null, because: null, evidence: null },
      ],
    }),
    ["A6"],
  );

  if (fails.length) {
    console.error("✗ الاختبار الذاتيّ لحارس سجلّ الأتمتة:");
    for (const f of fails) console.error("  - " + f);
    process.exit(1);
  }
  if (!quiet) console.log("✓ الاختبار الذاتيّ لحارس سجلّ الأتمتة: كلّ الكواشف الستّة سليمة.");
}

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

// ───────────────────────────── التشغيل الحقيقيّ ─────────────────────────────

function read(rel) {
  const p = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

/** يفشل **مغلقاً**: تحليلٌ متعذّرٌ يُعلَن ولا يُترك يبدو نجاحاً. */
function die(reason) {
  console.error(`✗ حارسُ سجلّ الأتمتة: تعذّر التحليل — ${reason}`);
  console.error("  (بُنيةُ الملفّ تغيّرت؟ عدّل الحارس معها — تمريرٌ صامتٌ هنا يُبطل الحراسة كلَّها.)");
  process.exit(1);
}

const registrySrc = read(REGISTRY_FILE);
if (registrySrc == null) die(`${REGISTRY_FILE} غير موجود`);

const statuses = {};
const declaredForward = [];
for (const [entity, cfg] of Object.entries(ENTITIES)) {
  const src = read(cfg.file);
  if (src == null) die(`${cfg.file} غير موجود`);
  const list = parseStringArray(src, cfg.array);
  if (list.length === 0) die(`${cfg.array} في ${cfg.file} عاد فارغاً`);
  statuses[entity] = list;
  if (entity === "workOrder") {
    const next = parseArrowMap(src, "WO_NEXT_STATUS");
    if (next.length === 0) die("WO_NEXT_STATUS في shared/workOrderStatus.ts عاد فارغاً");
    for (const [from, to] of next) declaredForward.push([entity, from, to]);
  }
}

const dead = parseStringArray(read(ENTITIES.invoice.file), "DEAD_INVOICE_STATUSES");
if (dead.length === 0) die("DEAD_INVOICE_STATUSES في shared/invoiceStatus.ts عاد فارغاً");
const deadTargets = dead.map((s) => ["invoice", s]);

const entries = parseRegistryEntries(registrySrc);
if (entries.length === 0) die(`لم يُعثر على أيّ مدخلٍ في ${REGISTRY_FILE}`);
const minLen = parseMinLength(registrySrc);
if (minLen == null) die("MIN_JUSTIFICATION_LENGTH غير موجود في السجلّ");
const excuses = parseExcuses(registrySrc);

const violations = findViolations({ statuses, declaredForward, deadTargets, entries, excuses, minLen });

const auto = entries.filter((e) => e.kind === "AUTO").length;
const manual = entries.filter((e) => e.kind === "MANUAL").length;
const scope = Object.entries(statuses)
  .map(([e, l]) => `${e} (${l.length} حالة)`)
  .join(" · ");

if (violations.length === 0) {
  console.log(`✓ سجلّ الأتمتة سليم: ${entries.length} انتقالاً — ${auto} آلياً و${manual} يدوياً.`);
  console.log(`  النطاق المفحوص: ${scope}. الحدّ الأدنى للتبرير: ${minLen} محرفاً.`);
  console.log("  (الحارسُ يقيس الوجودَ والتركيب لا جودةَ النصّ — انظر رأس الملفّ.)");
  process.exit(0);
}

console.error(`✗ سجلّ الأتمتة: ${violations.length} مخالفة.`);
for (const x of violations) console.error(`  - [${x.code}] ${x.key}: ${x.msg}`);
console.error("");
console.error("  القاعدة: كل خطوةٍ يملك النظام دليلها ويستطيع تنفيذها بأمان يُنفّذها ويُسجّلها");
console.error("  ويُبلِغ بعدها — ولا يعرضها كزرّ. واليدويّة تكتب حكمَها البشريّ، لا تُعيد صياغة اسمها.");
process.exit(1);
