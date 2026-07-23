// اختبار تماثُل الصلاحيات (المخاطرة الجهازية #٨: «الصلاحيات معلنة في نسختين») — تدقيق ١٧/٧.
//
// الجذر: بوّابات الواجهة اليدوية (RoleGate على عناصر التنقّل/التبويبات) وبوّابات الخادم
// (moduleProcedure/requireModuleGate/requireModule) تُعلَن **يدوياً في مكانين**، فتَنجرف عن قالب
// الأدوار في shared/permissions.ts — جذر الانجراف المرصود في ٧ مجالات (canSeeGate الفارغة، تبويبات
// module-only، بوّابات مالية مصدودة…). لا مولّد موحّد بعد؛ هذا الاختبار = **حارس المطابقة الآلي**
// الذي أوصى به التدقيق: يستورد القالب الحقيقيّ (لا يُعيد تنفيذه) ويحلّل الإعلانات الفعلية، فيُثبِّت
// التماثُل الحاليّ ويكسر أيّ انجراف مستقبليّ.
//
// الثوابت المفحوصة:
//   ① كل مفتاح وحدة مُشار إليه (خادماً أو واجهةً) موجودٌ في نموذج الصلاحيات (لا خطأ مطبعيّ/يتيم).
//   ② كل دورٍ مُشار إليه (allowedRoles/roles) دورٌ صالح.
//   ③ كل دورٍ في بوّابة خادمٍ صريحة يُسنِده القالب فعلاً (levelSatisfies) — لا «دورٌ مُعلَنٌ مسموحاً
//      بينما قالبه يمنع» (يعمل عبر override فقط ⇒ غالباً خطأ إعلان).
//   ④ كل دورٍ في بوّابة واجهةٍ ذات roles+module يُسنِده القالب فعلاً — إعلانٌ صادقٌ يطابق canSeeGate.
//
// DB-free: يستورد الخريطة الخالصة ويقرأ المصادر نصّاً. في حزمة vitest.unit.config.ts.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  ROLE_TEMPLATES,
  ALL_ROLES,
  PERMISSION_MODULES,
  levelSatisfies,
  type AccessLevel,
  type RoleKey,
} from "@shared/permissions";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

// مفاتيح الوحدات الصالحة = ما في PERMISSION_MODULES + أيّ مفتاح يظهر في القوالب (يشمل customers القديم).
const VALID_MODULES = new Set<string>([
  ...PERMISSION_MODULES.map((m) => m.key),
  ...Object.values(ROLE_TEMPLATES).flatMap((t) => Object.keys(t)),
]);
const VALID_ROLES = new Set<string>(ALL_ROLES);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e)) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"))
      out.push(p);
  }
  return out;
}

function parseRoles(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

interface Gate {
  file: string;
  line: number;
  roles: string[]; // فارغة = بلا قيد دور صريح
  module: string;
  level: AccessLevel;
}

/** بوّابات الخادم: moduleProcedure([roles], "mod", "LVL") و requireModuleGate([roles], "mod", "LVL") و requireModule("mod","LVL"). */
function extractServerGates(): Gate[] {
  const gates: Gate[] = [];
  const reWithRoles =
    /(?:moduleProcedure|requireModuleGate)\(\s*\[([^\]]*)\]\s*,\s*["']([^"']+)["']\s*,\s*["'](FULL|READ|NONE)["']\s*\)/g;
  const rePlain = /requireModule\(\s*["']([^"']+)["']\s*,\s*["'](FULL|READ|NONE)["']\s*\)/g;
  for (const file of walk(path.join(REPO, "server"), [".ts"])) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(REPO, file);
    const lineOf = (idx: number) => text.slice(0, idx).split(/\r?\n/).length;
    for (const m of text.matchAll(reWithRoles)) {
      gates.push({ file: rel, line: lineOf(m.index!), roles: parseRoles(m[1]), module: m[2], level: m[3] as AccessLevel });
    }
    for (const m of text.matchAll(rePlain)) {
      gates.push({ file: rel, line: lineOf(m.index!), roles: [], module: m[1], level: m[2] as AccessLevel });
    }
  }
  return gates;
}

/** بوّابات الواجهة: كائنات RoleGate تحمل module (+ roles/level اختيارياً) — سطراً سطراً (كلّها أحادية السطر). */
function extractUiGates(): Gate[] {
  const gates: Gate[] = [];
  const reModule = /module:\s*["']([^"']+)["']/;
  const reRoles = /roles:\s*\[([^\]]*)\]/;
  const reLevel = /level:\s*["'](FULL|READ|NONE)["']/;
  for (const file of walk(path.join(REPO, "client", "src"), [".ts", ".tsx"])) {
    const rel = path.relative(REPO, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const mm = reModule.exec(line);
      if (!mm) return;
      const rm = reRoles.exec(line);
      const lm = reLevel.exec(line);
      gates.push({
        file: rel,
        line: i + 1,
        roles: rm ? parseRoles(rm[1]) : [],
        module: mm[1],
        level: (lm ? lm[1] : "READ") as AccessLevel,
      });
    });
  }
  return gates;
}

const serverGates = extractServerGates();
const uiGates = extractUiGates();
const allGates = [...serverGates, ...uiGates];

describe("تماثُل الصلاحيات (المخاطرة #٨)", () => {
  it("استُخرجت بوّابات فعلية من الخادم والواجهة (الحارس ليس no-op)", () => {
    // حراسة ضد انكسار المحلِّل بصمت (خضرة كاذبة) — لو صفّر أحدهما فالتحليل معطوب.
    expect(serverGates.length).toBeGreaterThan(20);
    expect(uiGates.length).toBeGreaterThan(10);
  });

  it("① كل مفتاح وحدة (خادم/واجهة) موجودٌ في نموذج الصلاحيات", () => {
    const bad = allGates.filter((g) => !VALID_MODULES.has(g.module));
    expect(bad.map((g) => `${g.file}:${g.line} module="${g.module}"`)).toEqual([]);
  });

  it("② كل دورٍ مُشار إليه دورٌ صالح", () => {
    const bad = allGates.flatMap((g) =>
      g.roles.filter((r) => !VALID_ROLES.has(r)).map((r) => `${g.file}:${g.line} role="${r}"`),
    );
    expect(bad).toEqual([]);
  });

  it("③ كل دورٍ في بوّابة خادمٍ صريحة يُسنِده القالب فعلاً (لا إعلان أوسع من القالب)", () => {
    const bad: string[] = [];
    for (const g of serverGates) {
      for (const r of g.roles) {
        if (r === "admin") continue; // admin يعبُر دائماً
        const lvl = ROLE_TEMPLATES[r as RoleKey]?.[g.module];
        if (!levelSatisfies(lvl, g.level)) {
          bad.push(`${g.file}:${g.line} ${r} غير مُخوَّل ${g.module}≥${g.level} في القالب (${lvl ?? "NONE"})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("④ كل دورٍ في بوّابة واجهةٍ ذات roles+module يُسنِده القالب فعلاً (إعلانٌ صادقٌ يطابق canSeeGate)", () => {
    const bad: string[] = [];
    for (const g of uiGates) {
      if (!g.roles.length) continue; // module-only ⇒ يحسمه hasModuleAccess بلا قائمة roles
      for (const r of g.roles) {
        if (r === "admin") continue;
        const lvl = ROLE_TEMPLATES[r as RoleKey]?.[g.module];
        if (!levelSatisfies(lvl, g.level)) {
          bad.push(`${g.file}:${g.line} تبويبٌ يُعلن ${r} على ${g.module}≥${g.level} لكن القالب يمنع (${lvl ?? "NONE"})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("⑥ تحقّقٌ ذاتيّ: منطق الفحص يميّز الانجراف فعلاً (ليس vacuous)", () => {
    // بوّابة مُفتعَلة تُعلن الكاشير على reports (قالبه NONE) — يجب أن يرفضها فحص ③/④ نفسه.
    const drift = { roles: ["cashier"], module: "reports", level: "READ" as AccessLevel };
    const backed = drift.roles.every((r) => levelSatisfies(ROLE_TEMPLATES[r as RoleKey]?.[drift.module], drift.level));
    expect(backed).toBe(false); // لو صار true فالقالب/المنطق انهار ⇒ الفحوص أعلاه صارت خضراء كاذبة
    // والعكس: دورٌ يُسنِده القالب يمرّ.
    expect(levelSatisfies(ROLE_TEMPLATES.manager.reports, "READ")).toBe(true);
  });

  it("⑤ كل وحدة في PERMISSION_MODULES مُنفَّذةٌ ببوّابة خادمٍ واحدة على الأقل (لا وحدة مُعلَنة بلا إنفاذ)", () => {
    const gatedModules = new Set(serverGates.map((g) => g.module));
    const declared = PERMISSION_MODULES.map((m) => m.key);
    // مُستثنى (مُنفَّذٌ بالدور لا بالوحدة، وواجهتُه role-based مطابقةٌ فلا انجراف):
    //   customers — مُدار عبر وحدة crm.
    //   users/settings — بوّابة adminProcedure/managerProcedure (لا requireModule)، وواجهتُهما managerOnly
    //     (لا module) عمداً (تعليق AppLayout: محاور بتبويبات managerOnly لا تُفتَح بمنح وحدة). لهما قالبٌ
    //     في المصفوفة للعرض/التحرير فقط. الباقي يجب أن يُنفَّذ بوّابةَ وحدةٍ خادمية.
    const ROLE_GATED = new Set(["customers", "users", "settings"]);
    // "tasks" لم تعد مُستثناة (S2، ٢٣/٧/٢٦): tasksReadProcedure/tasksWriteProcedure/tasksManagerProcedure
    // في server/trpc.ts تربطها ببوّابة وحدة خادمية فعلية الآن (tasksRouter.ts).
    const orphan = declared.filter((k) => !gatedModules.has(k) && !ROLE_GATED.has(k));
    expect(orphan).toEqual([]);
  });
});
