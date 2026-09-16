/**
 * عقدُ فعل تدقيق المرتجع — **حارسُ الانحراف بين الكاتب والقارئ** (تدقيق ١/٩/٢٦).
 *
 * كاشفُ الشذوذ D3-ب («معالجو الإرجاع») كان يستعلم `auditLogs` بالفعل `'return.create'` وهو
 * فعلٌ **لا يكتبه أيّ سطرٍ في الخادم** ⇒ صفرُ صفوفٍ أبداً على الإنتاج. ونجا العطبُ سنةً
 * لأنّ اختبارَه كان يُدرج صفَّ التدقيق **بيده** بنفس النصّ الميت: حارسٌ يقرأ ما كتبه هو.
 *
 * هذا الملفّ يقطع الطريق على تكرارها: يفحص **الشيفرة نفسها** لا سلوكاً في قاعدة اختبار.
 * لا يلمس قاعدةً ⇒ مُسجَّلٌ في `vitest.unit.config.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RETURN_EXECUTED_AUDIT_ACTION } from "../returns/auditActions";

const read = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

const RETURN_ROUTER = read("routers/returnRouter.ts");
const SALES_CONTROL_ROUTER = read("routers/salesControlRouter.ts");
const SALES_CONTROL_AUDIT = read("services/sale/controlAudit.ts");
const DECISION_SALES_SOURCE = read("services/decisions/sources/sales.ts");
const ANOMALY_WATCH = read("services/reports/anomalyWatch.ts");

describe("عقد فعل تدقيق تنفيذ المرتجع", () => {
  it("الفعل نصٌّ مستقرّ — تغييرُه قرارٌ لا سهو", () => {
    // القيمة مُثبَّتة عمداً: تغييرها يُبطل مطابقة صفوف التدقيق التاريخية في تقارير الرقيب.
    expect(RETURN_EXECUTED_AUDIT_ACTION).toBe("return.execute");
  });

  it("كلُّ مسارات التنفيذ تكتب الفعل من المصدر المشترك لا بنصٍّ ثابت", () => {
    // مسارا `returnRouter`: المالك الفوريّ + اعتماد طلب المحطة.
    const returnRouterWrites = RETURN_ROUTER.match(/action:\s*RETURN_EXECUTED_AUDIT_ACTION/g) ?? [];
    expect(returnRouterWrites.length).toBe(2);
    expect(RETURN_ROUTER).toContain('from "../services/returns/auditActions"');

    // مسارُ الاعتماد المحكوم — كاتبٌ **واحد** (`sale/controlAudit.ts`) يستدعيه الراوترُ وصندوقُ
    // القرارات معاً: كان الراوتر وحده يكتبه فيتخطّاه اعتمادُ الصندوق (Codex على #1004).
    expect(SALES_CONTROL_AUDIT).toMatch(/action:\s*RETURN_EXECUTED_AUDIT_ACTION/);
    expect(SALES_CONTROL_AUDIT).toContain('from "../returns/auditActions"');
    // ولا يكتبه إلّا لمرتجعٍ فعلاً — لا لكلّ أنواع طلبات التحكّم.
    expect(SALES_CONTROL_AUDIT).toContain('requestType !== "SALES_RETURN"');
    for (const [name, source] of [
      ["salesControlRouter", SALES_CONTROL_ROUTER],
      ["decisions/sources/sales", DECISION_SALES_SOURCE],
    ] as const) {
      expect(source, `${name} لا يستدعي الكاتب المشترك`).toContain("recordGovernedReturnExecution(");
      // ⛔ لا نسخةَ ثانية للكتابة خارج الكاتب المشترك — النسختان تنجرفان.
      expect(source, `${name} يكتب الفعل بنفسه`).not.toMatch(/action:\s*RETURN_EXECUTED_AUDIT_ACTION/);
    }
  });

  it("رقيبُ الشذوذ يقرأ الفعل من المصدر نفسه — لا نصّاً ثابتاً في SQL", () => {
    expect(ANOMALY_WATCH).toContain("a.action = ${RETURN_EXECUTED_AUDIT_ACTION}");
    expect(ANOMALY_WATCH).toContain('from "../returns/auditActions"');
    // ⛔ النصّ الميت الذي كان يُعطّل الكاشف لا يعود إلى أيٍّ من الأطراف.
    for (const [name, source] of [
      ["anomalyWatch", ANOMALY_WATCH],
      ["returnRouter", RETURN_ROUTER],
      ["salesControlRouter", SALES_CONTROL_ROUTER],
      ["controlAudit", SALES_CONTROL_AUDIT],
      ["decisions/sources/sales", DECISION_SALES_SOURCE],
    ] as const) {
      expect(source, `${name} يحمل الفعل الميت 'return.create'`).not.toContain("'return.create'");
      expect(source, `${name} يحمل الفعل الميت "return.create"`).not.toContain('"return.create"');
    }
  });

  it("أفعالُ الطلب صفريّ الأثر تبقى متمايزة عن فعل التنفيذ", () => {
    // الطلبُ لا يُحسَب تنفيذاً: خلطُهما يجعل رقيبَ التركّز يعدّ نوايا لا أفعالاً.
    expect(RETURN_ROUTER).toContain('action: "return.request"');
    expect(RETURN_ROUTER).toContain('action: "return.rejectRequest"');
    expect(RETURN_EXECUTED_AUDIT_ACTION).not.toBe("return.request");
  });
});
