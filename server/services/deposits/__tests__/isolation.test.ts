/* ============================================================================
 * اختبار عزل نواتَي العرابين والسلف — م٣ من برنامج v2 «السهل الممتنع» (الخطّة §٨ · الخطر ٥)
 *
 * نقيٌّ بلا قاعدة: يقرأ الشيفرة ويثبت **اتّجاه التبعيّة** لا السلوك (السلوكَ تحرسه اختبارات
 * receptionDeposits · workOrder* · pr495ReviewFixes القائمة كما هي — معيار خروج م٣: صفر تعديلٍ فيها).
 *
 *  ١) لا ملفّ خارج `server/services/{deposits,advances}/` يستورد ملفّاً داخلها إلّا عبر `index.ts`.
 *  ٢) نواة العرابين — **كلّ** ملفّاتها لا `index.ts` وحده — لا تستورد من `reception/` ولا `workOrder/`:
 *     النواة لا تعرف مستهلكيها (الاستيرادُ المعاكس هو المطلوب: هم يستوردونها).
 *  ٣) بوّابة الخطر ٥ («حذف الاستقبال يكسر أوامر الشغل»): لا وحدةً خارج `reception/` تستورد
 *     `reception/deposits` — كتّابُ الإيصالات محوِّلٌ للاستقبال، ودفترُ المال المحتجَز في النواة.
 *     (الاختبارات مستثناة: pr495ReviewFixes/posReceptionPaymentFailClosed تستوردان كتّاب الإيصالات
 *     مباشرةً، وهما «اختبارٌ قائم» لا يُلمَس.)
 *
 * ⭐ ضدّ الأخضر الكاذب: المحلّلُ يُختبَر ذاتياً على أمثلةٍ معلومة، ويُشترط أن يجد المسحُ ملفّاتٍ
 *    ومستهلكاً حقيقياً للنواة — حارسٌ لا يجد شيئاً ليس حارساً. والتعليقاتُ تُجرَّد أوّلاً: ذكرُ
 *    مسارٍ قديم في تعليقٍ ليس استيراداً (فخّ حارس انجراف الرسائل نفسه، ٣/٩/٢٦).
 * ========================================================================== */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const NUCLEI = ["server/services/deposits", "server/services/advances"] as const;
/** مستهلكو نواة العرابين — لا يجوز أن تستوردهم النواة. */
const DEPOSITS_NUCLEUS = "server/services/deposits";
const DEPOSITS_CONSUMER_DIRS = ["server/services/reception", "server/services/workOrder"] as const;
/** مسارُ الداخليّات القديم — كتّابُ الإيصالات (يبقون في الاستقبال، انظر deposits/index.ts). */
const LEGACY_WRITERS_MODULE = "server/services/reception/deposits";
const LEGACY_OWNER_DIR = "server/services/reception";

function toPosix(p: string) {
  return p.replaceAll("\\", "/");
}

function walk(absDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(toPosix(path.relative(REPO_ROOT, abs)));
  }
  return out;
}

function isTestFile(rel: string) {
  return /\.test\.tsx?$/.test(rel) || rel.includes("/__tests__/");
}

function under(rel: string, dir: string) {
  return rel === dir || rel.startsWith(`${dir}/`);
}

/**
 * يحذف التعليقات ويُبقي السلاسل (ماسحٌ يتتبّع الحالة — لا `replace(/\/\/.*$/gm)` الذي يقصّ
 * داخل السلاسل عند أوّل `//` في أيّ عنوان). نُبقي «\n» ليبقى ترقيمُ الأسطر سليماً.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** محدّداتُ الاستيراد في ملفّ (بعد تجريد التعليقات): from "…" · import "…" · import("…") · vi.mock("…"). */
export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"'\n]+)["']/g,
    /^\s*import\s+["']([^"'\n]+)["']/gm,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bmock\s*\(\s*["']([^"'\n]+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

/**
 * يحلّ محدّداً **نسبياً** إلى مسارٍ من جذر المستودع بلا امتدادٍ ولا `/index` — أو `null` لغير
 * النسبيّ (`@shared/*` يشير إلى shared/ و`@/*` إلى الواجهة؛ لا يدخل أيٌّ منهما النواة).
 */
export function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return joined.replace(/\.(ts|tsx|js|mjs|cjs)$/, "").replace(/\/index$/, "");
}

function readRel(rel: string) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function scannedFiles(): string[] {
  return [...walk(path.join(REPO_ROOT, "server")), ...walk(path.join(REPO_ROOT, "shared"))].sort();
}

describe("المحلّل — اختبارٌ ذاتيّ (حارسٌ يُنذر كذباً أو يعمى يُتجاوَز)", () => {
  it("يحلّ المحدّدات النسبية إلى مسارٍ من الجذر بلا امتدادٍ ولا /index", () => {
    expect(resolveRelative("server/services/workOrder/deliver.ts", "../deposits")).toBe("server/services/deposits");
    expect(resolveRelative("server/services/workOrder/deliver.ts", "../deposits/index")).toBe("server/services/deposits");
    expect(resolveRelative("server/services/workOrder/deliver.ts", "../deposits/index.ts")).toBe("server/services/deposits");
    expect(resolveRelative("server/services/workOrder/deliver.ts", "../deposits/orderPayments.ts")).toBe(
      "server/services/deposits/orderPayments",
    );
    expect(resolveRelative("server/services/workOrder/cancel.ts", "../reception/deposits")).toBe(
      "server/services/reception/deposits",
    );
    expect(resolveRelative("server/services/advances/__tests__/x.test.ts", "..")).toBe("server/services/advances");
    expect(resolveRelative("server/services/deposits/index.ts", "./orderPayments")).toBe(
      "server/services/deposits/orderPayments",
    );
    expect(resolveRelative("server/routers/x.ts", "@shared/errors")).toBeNull();
    expect(resolveRelative("server/routers/x.ts", "drizzle-orm")).toBeNull();
  });

  it("يلتقط from/import/import()/vi.mock ويتجاهل ما في التعليقات", () => {
    const src = [
      'import { a } from "../deposits";',
      'import "./sideEffect";',
      'const x = await import("../advances");',
      'vi.mock("../../services/advances", () => ({}));',
      '// import { b } from "../reception/deposits";',
      '/* from "../workOrder/create" */',
      'const url = "https://x.test/a"; import { c } from "../reception";',
    ].join("\n");
    // الترتيبُ غير مهمّ للحارس (الأنماط تُمسح تباعاً) — يُقارَن مرتّباً.
    expect([...importSpecifiers(src)].sort()).toEqual(
      ["../deposits", "../advances", "../reception", "./sideEffect", "../../services/advances"].sort(),
    );
  });
});

describe("عزل النواتَين — server/services/{deposits,advances}", () => {
  const files = scannedFiles();

  it("المسحُ حقيقيّ: ملفّاتٌ كثيرة، والبرميلان موجودان، ولأمر الشغل مستهلكٌ فعليّ للنواة", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const nucleus of NUCLEI) expect(existsSync(path.join(REPO_ROOT, nucleus, "index.ts"))).toBe(true);
    const deliver = "server/services/workOrder/deliver.ts";
    const targets = importSpecifiers(readRel(deliver)).map((s) => resolveRelative(deliver, s));
    expect(targets).toContain(DEPOSITS_NUCLEUS);
  });

  it("١) لا ملفّ خارج النواة يستورد داخليّاتها — البرميل index.ts هو الباب الوحيد", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (NUCLEI.some((n) => under(file, n))) continue;
      for (const spec of importSpecifiers(readRel(file))) {
        const target = resolveRelative(file, spec);
        if (!target) continue;
        const nucleus = NUCLEI.find((n) => under(target, n));
        if (nucleus && target !== nucleus) {
          violations.push(`${file} → «${spec}» (داخليّة ${nucleus} — المسموح: ${nucleus}/index.ts وحده)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("٢) نواة العرابين لا تستورد مستهلكيها: لا reception/ ولا workOrder/ من أيّ ملفٍّ فيها", () => {
    const nucleusFiles = files.filter((f) => under(f, DEPOSITS_NUCLEUS));
    expect(nucleusFiles.length).toBeGreaterThanOrEqual(2); // index.ts + orderPayments.ts على الأقلّ
    const violations: string[] = [];
    for (const file of nucleusFiles) {
      for (const spec of importSpecifiers(readRel(file))) {
        const target = resolveRelative(file, spec);
        if (!target) continue;
        const consumer = DEPOSITS_CONSUMER_DIRS.find((d) => under(target, d));
        if (consumer) violations.push(`${file} → «${spec}» (يستورد مستهلكاً: ${consumer})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("٣) بوّابة الخطر ٥: لا وحدةً خارج reception/ تستورد reception/deposits (كتّاب الإيصالات)", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (isTestFile(file) || under(file, LEGACY_OWNER_DIR)) continue;
      for (const spec of importSpecifiers(readRel(file))) {
        if (resolveRelative(file, spec) === LEGACY_WRITERS_MODULE) {
          violations.push(`${file} → «${spec}» (استورد من ../deposits — النواة — لا من الاستقبال)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
