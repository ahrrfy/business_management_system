/**
 * حارسُ قاموس `workOrderKanban` — على نمط `workOrderStatus.test.ts`.
 *
 * الثابتُ المحروس ليس التسمية بل **المطابقة مع مصدرَيها الحيَّين**: القيم تُقرأ من
 * `drizzle/schema.ts` نفسه (`mysqlEnum("woKanbanState", …)`)، ونمطُ الاستهلاك يمنع
 * استعمالها **حاكماً منطقياً** — الحرّاسُ المالية تبقى على `status` وحدها.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WO_KANBAN_STATES,
  isKanbanStateApplicable,
  isWorkOrderKanbanState,
  nextKanbanStateInCycle,
  workOrderKanbanDotCls,
  workOrderKanbanStateHint,
  workOrderKanbanStateLabel,
} from "./workOrderKanban";

const ROOT = join(__dirname, "..");

describe("workOrderKanban", () => {
  it("قيَم الـenum مطابقةٌ لعمود drizzle/schema.ts وSQL هجرة 0292", () => {
    const schema = readFileSync(join(ROOT, "drizzle/schema.ts"), "utf8");
    // نلتقط سطر تعريف mysqlEnum("kanbanState", [...]) — أوّل معامل = اسم العمود (لا اسم النوع).
    const match = schema.match(/mysqlEnum\("kanbanState",\s*\[([^\]]+)\]/);
    expect(match, "لم يُعثر على تعريف mysqlEnum(\"kanbanState\") في drizzle/schema.ts").toBeTruthy();
    const raw = match![1];
    const values = Array.from(raw.matchAll(/"([A-Z_]+)"/g)).map((m) => m[1]);
    expect(values).toEqual([...WO_KANBAN_STATES]);
    // وتُطابق قائمةَ SQL في الهجرة (نفس القيَم — الترتيب حاكمٌ لو تغيّرت الافتراضات).
    const sql = readFileSync(
      join(ROOT, "drizzle/migrations/0292_add_work_order_kanban_state.sql"),
      "utf8",
    );
    const sqlMatch = sql.match(/kanbanState`\s+ENUM\(([^)]+)\)/);
    expect(sqlMatch, "لم يُعثر على تعريف عمود kanbanState في SQL 0292").toBeTruthy();
    const sqlValues = Array.from(sqlMatch![1].matchAll(/'([A-Z_]+)'/g)).map((m) => m[1]);
    expect(sqlValues).toEqual([...WO_KANBAN_STATES]);
  });

  it("كلُّ قيمةٍ لها تسميةٌ عربيّةٌ وتلميحٌ غير فارغَين", () => {
    for (const v of WO_KANBAN_STATES) {
      const label = workOrderKanbanStateLabel(v);
      const hint = workOrderKanbanStateHint(v);
      expect(label, `تسمية ${v}`).toBeTruthy();
      expect(hint, `تلميح ${v}`).toBeTruthy();
      expect(label).not.toBe(v); // لا نسقط على المفتاح الخامّ
    }
  });

  it("القيمةُ غير الصالحة تسقط إلى NORMAL في العرض", () => {
    expect(workOrderKanbanStateLabel(null)).toBe(workOrderKanbanStateLabel("NORMAL"));
    expect(workOrderKanbanStateLabel(undefined)).toBe(workOrderKanbanStateLabel("NORMAL"));
    expect(workOrderKanbanStateLabel("BOGUS")).toBe(workOrderKanbanStateLabel("NORMAL"));
    expect(workOrderKanbanDotCls("BOGUS")).toBe(workOrderKanbanDotCls("NORMAL"));
  });

  it("isWorkOrderKanbanState يُميّز الصالح من غيره", () => {
    expect(isWorkOrderKanbanState("NORMAL")).toBe(true);
    expect(isWorkOrderKanbanState("READY")).toBe(true);
    expect(isWorkOrderKanbanState("BLOCKED")).toBe(true);
    expect(isWorkOrderKanbanState("normal")).toBe(false); // حسّاسة للحالة
    expect(isWorkOrderKanbanState(null)).toBe(false);
    expect(isWorkOrderKanbanState(42)).toBe(false);
  });

  it("nextKanbanStateInCycle يدور بلا انقطاع", () => {
    expect(nextKanbanStateInCycle("NORMAL")).toBe("READY");
    expect(nextKanbanStateInCycle("READY")).toBe("BLOCKED");
    expect(nextKanbanStateInCycle("BLOCKED")).toBe("NORMAL");
    // القيمة الفاسدة تُعامَل كـNORMAL
    expect(nextKanbanStateInCycle(null)).toBe("READY");
    expect(nextKanbanStateInCycle("bogus")).toBe("READY");
  });

  it("isKanbanStateApplicable على الحالات النشطة فقط", () => {
    expect(isKanbanStateApplicable("RECEIVED")).toBe(true);
    expect(isKanbanStateApplicable("IN_PROGRESS")).toBe(true);
    expect(isKanbanStateApplicable("READY")).toBe(true);
    // النهائيات لا تحمل إشارةً بمعنى
    expect(isKanbanStateApplicable("DELIVERED")).toBe(false);
    expect(isKanbanStateApplicable("CANCELLED")).toBe(false);
    expect(isKanbanStateApplicable(null)).toBe(false);
  });
});
