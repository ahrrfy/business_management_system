/**
 * حارس قاموس حالة أمر الشغل (١٩/٨، ش٠) — على نمط `invoiceStatus`.
 *
 * الثابت المحروس ليس التسمية بل **المطابقة مع مصدرَيها الحيَّين**: المفاتيح تُقرأ من
 * `drizzle/schema.ts` نفسه، وأفعالُ الخطّ الزمنيّ تُقرأ من `workOrderRouter.ts` نفسه.
 * حارسٌ يقرأ من مصدرٍ غير الذي ينفّذ عليه ليس حارساً — لذا لا قائمةَ مكتوبةً بيدٍ هنا:
 * إضافةُ حالةٍ أو فعلٍ في الشيفرة **تُحمِّر هذا الملف** حتى يُسمَّى عربياً.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORK_ORDER_STATUSES,
  WO_ACTIVE_STATUSES,
  WO_CLOSED_STATUSES,
  WO_NEXT_STATUS,
  WO_PROGRESS_STAGES,
  WO_STAGE_INDEX,
  WO_STATUS_HUE,
  WO_STATUS_PRINT_COLOR,
  WO_TIMELINE_LABEL,
  isWorkOrderActive,
  isWorkOrderClosed,
  isWorkOrderStatus,
  workOrderStatusHue,
  workOrderStatusLabel,
  workOrderTimelineLabel,
} from "./workOrderStatus";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** قيم enum الحيّة من المخطّط — لا نسخةَ يدويّة. */
function enumFromSchema(): string[] {
  const src = read("drizzle/schema.ts");
  const m = /mysqlEnum\("workOrderStatus",\s*\[([^\]]*)\]/.exec(src);
  if (!m) throw new Error("تعذّر إيجاد mysqlEnum(\"workOrderStatus\") في drizzle/schema.ts");
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

/** أفعال التدقيق الحيّة على entityType:"workOrder" من الراوتر. */
function timelineActionsFromRouter(): string[] {
  const src = read("server/routers/workOrderRouter.ts");
  const found = new Set<string>();
  // نمطان: كائنٌ متعدّد الأسطر، وسطرٌ واحد logAudit(..., { action: "…", entityType: "workOrder" … }).
  for (const m of src.matchAll(/action:\s*"(workOrder\.[A-Za-z]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

describe("قاموس حالة أمر الشغل", () => {
  it("⭐ المفاتيح تطابق enum المخطّط الحيّ — لا زيادة ولا نقصان", () => {
    expect([...WORK_ORDER_STATUSES].sort()).toEqual(enumFromSchema().sort());
  });

  it("⭐ كل فعلٍ يسجّله الراوتر له اسمٌ عربيّ في الخطّ الزمنيّ", () => {
    const live = timelineActionsFromRouter();
    expect(live.length).toBeGreaterThanOrEqual(11); // كانت الشاشة تغطّي ٦ فقط
    const missing = live.filter((a) => !(a in WO_TIMELINE_LABEL));
    expect({ missing }).toEqual({ missing: [] });
    // ولا اسمَ لفعلٍ لا يسجّله أحد (قاموسٌ يتضخّم بلا مقابل).
    const stale = Object.keys(WO_TIMELINE_LABEL).filter((a) => !live.includes(a));
    expect({ stale }).toEqual({ stale: [] });
  });

  it("⭐ صفر مفتاحٍ إنجليزيّ يظهر للمستخدم", () => {
    for (const s of WORK_ORDER_STATUSES) {
      const label = workOrderStatusLabel(s);
      expect(label).not.toMatch(/[A-Za-z]/);
      expect(label.length).toBeGreaterThan(2);
    }
    for (const a of Object.keys(WO_TIMELINE_LABEL)) {
      expect(workOrderTimelineLabel(a)).not.toMatch(/[A-Za-z]/);
    }
  });

  it("الحالة الغريبة لا تسقط على مفتاحها الخامّ", () => {
    // عرضُ «IN_REVIEW» يبدو مقصوداً؛ «حالة غير معروفة» تقول الحقيقة.
    expect(workOrderStatusLabel("IN_REVIEW")).toBe("حالة غير معروفة");
    expect(workOrderStatusLabel(null)).toBe("—");
    expect(isWorkOrderStatus("IN_REVIEW")).toBe(false);
  });

  it("الأسماء فريدة — لا حالتان باسمٍ واحد", () => {
    const labels = WORK_ORDER_STATUSES.map(workOrderStatusLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("المجموعتان تقسيمٌ تامّ: كل حالةٍ نشِطةٌ أو مُغلقة، ولا واحدةَ في الاثنتين", () => {
    for (const s of WORK_ORDER_STATUSES) {
      expect(isWorkOrderActive(s) !== isWorkOrderClosed(s)).toBe(true);
    }
    expect(WO_ACTIVE_STATUSES.length + WO_CLOSED_STATUSES.length).toBe(WORK_ORDER_STATUSES.length);
    // الملغى **مُغلق** لا نشِط — وإلّا حُسب في الحمل وقيمة العمل الجاري.
    expect(isWorkOrderClosed("CANCELLED")).toBe(true);
  });

  it("لكل حالةٍ درجةُ لونٍ ومركزٌ ولونُ طباعة", () => {
    for (const s of WORK_ORDER_STATUSES) {
      expect(s in WO_STATUS_HUE).toBe(true);
      expect(s in WO_STAGE_INDEX).toBe(true);
      expect(WO_STATUS_PRINT_COLOR[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    // الملغى خارج شريط التقدّم، والغريبةُ تأخذ المحايدة.
    expect(WO_STAGE_INDEX.CANCELLED).toBe(-1);
    expect(workOrderStatusHue("CANCELLED")).toBe(255);
    expect(workOrderStatusHue("IN_REVIEW")).toBe(255);
    expect(workOrderStatusHue("READY")).toBe(293);
  });

  it("شريط التقدّم ثلاث مراحل بترتيب الـenum، والتسليم نهايةٌ لا مرحلة", () => {
    expect(WO_PROGRESS_STAGES.map((x) => x.key)).toEqual(["RECEIVED", "IN_PROGRESS", "READY"]);
    expect(WO_PROGRESS_STAGES.map((x) => x.label)).toEqual(
      ["RECEIVED", "IN_PROGRESS", "READY"].map(workOrderStatusLabel),
    );
  });

  it("الانتقال الأماميّ سلسلةٌ واحدة تنتهي عند التسليم، ولا مخرجَ أماميّ من نهائيّة", () => {
    expect(WO_NEXT_STATUS.RECEIVED).toBe("IN_PROGRESS");
    expect(WO_NEXT_STATUS.IN_PROGRESS).toBe("READY");
    expect(WO_NEXT_STATUS.READY).toBe("DELIVERED");
    expect(WO_NEXT_STATUS.DELIVERED).toBeUndefined();
    expect(WO_NEXT_STATUS.CANCELLED).toBeUndefined();
  });

  it("⛔ لا قاموسَ حالةٍ محلّيٌّ جديد في الشاشات", () => {
    // الحارس البنيويّ: أيّ ملفٍّ يعرّف خريطةً تحمل RECEIVED وIN_PROGRESS معاً هو قاموسٌ ثامن.
    const files = [
      "client/src/pages/WorkOrders.tsx",
      "client/src/pages/WorkOrderStation.tsx",
      "client/src/pages/WorkOrderDetail.tsx",
      "client/src/pages/WIPReport.tsx",
      "client/src/components/reception/ReceptionOrderQueue.tsx",
      "client/src/lib/printing/workOrderRaster.ts",
    ];
    for (const f of files) {
      const src = read(f);
      const offenders = [...src.matchAll(/RECEIVED:\s*"[^"]*"/g)].map((m) => m[0]);
      expect({ [f]: offenders }).toEqual({ [f]: [] });
    }
  });
});
