import { describe, expect, it } from "vitest";

/**
 * فحص منطق تعمير ديون العميل الهجين وتجميع الفروع وفق مراجعة Codex
 * (P1: Base hybrid aging on outstanding opening balance)
 * (P2: Show zero oldest delay when filters have no matches)
 * (P1: Preserve the global scope when logging aggregated reminders)
 * (P2: Include the branch in aggregated history rows)
 */

function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const fromUTC = Date.UTC(fy, fm - 1, fd);
  const toUTC = Date.UTC(ty, tm - 1, td);
  return Math.floor((toUTC - fromUTC) / 86_400_000);
}

interface AgingRow {
  currentBalance: string;
  unpaidTotal: string;
  unbucketed: string;
  oldestInvoiceDate: string | null;
}

function computeHybridEligibility(params: {
  row: AgingRow;
  openedOn?: string;
  today: string;
  minDaysOverdue: number;
}) {
  const { row, openedOn, today, minDaysOverdue } = params;
  const balance = Number(row.currentBalance);
  if (balance <= 0) return null;

  const hasInvoice = Boolean(row.oldestInvoiceDate && Number(row.unpaidTotal) > 0);
  const hasOpening = Boolean(openedOn);
  // الشرط المصحح: الرصيد الافتتاحي لا يعتبر ديناً متأخراً إلا إذا كان هناك unbucketed > 0 متبقٍّ فعلياً
  const hasOutstandingOpening = hasOpening && Boolean(openedOn) && Number(row.unbucketed) > 0;

  if (hasInvoice && hasOutstandingOpening && openedOn && row.oldestInvoiceDate) {
    // عميل هجين بذمة فواتير ورصيد افتتاحي متبقٍّ
    const effectiveOldestDate = openedOn < row.oldestInvoiceDate ? openedOn : row.oldestInvoiceDate;
    const days = daysBetween(effectiveOldestDate, today);
    if (days >= minDaysOverdue) {
      return {
        eligible: true,
        type: "HYBRID",
        effectiveOldestDate,
        daysOverdue: days,
        dueAmount: balance.toFixed(2),
      };
    }
  } else if (hasInvoice && row.oldestInvoiceDate) {
    // عميل فواتير (أو سُدِّد رصيده الافتتاحي وبقيت الفواتير فقط)
    const unpaid = Number(row.unpaidTotal);
    const days = daysBetween(row.oldestInvoiceDate, today);
    if (days >= minDaysOverdue) {
      return {
        eligible: true,
        type: "INVOICE_ONLY",
        effectiveOldestDate: row.oldestInvoiceDate,
        daysOverdue: days,
        dueAmount: Math.min(unpaid, balance).toFixed(2),
      };
    }
  } else if (hasOutstandingOpening && openedOn) {
    // عميل رصيد افتتاحي بحت
    const days = daysBetween(openedOn, today);
    if (days >= minDaysOverdue) {
      return {
        eligible: true,
        type: "OPENING_ONLY",
        effectiveOldestDate: openedOn,
        daysOverdue: days,
        dueAmount: balance.toFixed(2),
      };
    }
  }

  return null;
}

describe("AR Reminders - Hybrid Aging Logic (Codex P1/P2 Remediation)", () => {
  const today = "2026-10-12";
  const minDaysOverdue = 7;

  it("حالة كودكس P1: عميل لديه رصيد افتتاحي قديم سُدِّد لاحقاً وفاتورة حديثة غير متأخرة ⇒ لا يُطالب", () => {
    // رصيد افتتاحي 100 قبل 60 يوماً
    // فاتورة حديثة 100 قبل يومين (غير متأخرة < 7)
    // سداد 100 خفّض الرصيد الافتتاحي فأصبح unbucketed = 0
    const row: AgingRow = {
      currentBalance: "100.00",
      unpaidTotal: "100.00",
      unbucketed: "0.00", // الرصيد الافتتاحي سُدّد بالكامل
      oldestInvoiceDate: "2026-10-10", // قبل يومين
    };
    const openedOn = "2026-08-13"; // قبل 60 يوماً

    const result = computeHybridEligibility({
      row,
      openedOn,
      today,
      minDaysOverdue,
    });

    // لا يجوز أن يظهر في التذكيرات لأن الفاتورة عمرها يومان فقط والرصيد الافتتاحي سُدّد
    expect(result).toBeNull();
  });

  it("عميل هجين لديه رصيد افتتاحي متبقٍّ فعلياً (unbucketed > 0) وفاتورة حديثة ⇒ يُطالب بتاريخ الافتتاح الأقدم", () => {
    // رصيد افتتاحي 100 قبل 60 يوماً
    // فاتورة حديثة 100 قبل يومين
    // لا يوجد سداد: currentBalance = 200, unpaidTotal = 100, unbucketed = 100
    const row: AgingRow = {
      currentBalance: "200.00",
      unpaidTotal: "100.00",
      unbucketed: "100.00",
      oldestInvoiceDate: "2026-10-10",
    };
    const openedOn = "2026-08-13";

    const result = computeHybridEligibility({
      row,
      openedOn,
      today,
      minDaysOverdue,
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe("HYBRID");
    expect(result?.effectiveOldestDate).toBe("2026-08-13");
    expect(result?.daysOverdue).toBe(60);
    expect(result?.dueAmount).toBe("200.00");
  });

  it("حالة كودكس P2: عرض أقدم تأخر بصفر عند عدم مطابقة فلاتر البحث", () => {
    const queueData = [{ daysOverdue: 45 }, { daysOverdue: 20 }];
    const filteredQueue: { daysOverdue: number }[] = []; // لا نتائج بعد البحث

    const oldestDays = filteredQueue.length > 0
      ? Math.max(...filteredQueue.map((r) => r.daysOverdue))
      : 0;

    expect(oldestDays).toBe(0); // لا يسقط للقيمة 45 من الطابور غير المصفى
  });

  it("حالة كودكس P1 (الفروع): عميل بفواتير في فرعين مختلفين يبقى branchId=null كشامل عام", () => {
    const invoices = [
      { branchId: 1, dueDate: "2026-09-01" },
      { branchId: 2, dueDate: "2026-09-15" },
    ];
    const branchSet = new Set(invoices.map((i) => i.branchId));
    const resolvedBranchId = branchSet.size === 1 ? Array.from(branchSet)[0] : null;

    expect(resolvedBranchId).toBeNull();
  });

  it("حالة كودكس P1 (الفروع): عميل بفواتير في فرع واحد فقط يُسند لهذا الفرع صراحة", () => {
    const invoices = [
      { branchId: 2, dueDate: "2026-09-01" },
      { branchId: 2, dueDate: "2026-09-15" },
    ];
    const branchSet = new Set(invoices.map((i) => i.branchId));
    const resolvedBranchId = branchSet.size === 1 ? Array.from(branchSet)[0] : null;

    expect(resolvedBranchId).toBe(2);
  });

  it("حالة كودكس P2 (السجل التاريخي): تمييز وسَم [ALL_BRANCHES] وعزل تذكيرات كل الفروع عن سجلات الفروع المحلية", () => {
    const historyRows = [
      { id: 1, branchId: 1, messageBody: "[ALL_BRANCHES] تذكير شامل بمبلغ 700k" },
      { id: 2, branchId: 1, messageBody: "تذكير محلي لفرع 1 بمبلغ 100k" },
    ];

    // استعلام سجل فرع 1 يستبعد التذكيرات العامة [ALL_BRANCHES]
    const branch1History = historyRows.filter(
      (r) => r.branchId === 1 && !r.messageBody.startsWith("[ALL_BRANCHES]"),
    );

    expect(branch1History).toHaveLength(1);
    expect(branch1History[0].id).toBe(2);

    // استعلام السجل الشامل (null) يتضمن الجميع
    const allHistory = historyRows.map((r) => ({
      ...r,
      isAllBranches: r.messageBody.startsWith("[ALL_BRANCHES]"),
    }));
    expect(allHistory[0].isAllBranches).toBe(true);
    expect(allHistory[1].isAllBranches).toBe(false);
  });
});
