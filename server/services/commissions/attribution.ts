import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { eq } from "drizzle-orm";
import type { Tx } from "../../db";
import {
  invoiceAttributions,
  type AttributionRole,
  type AttributionMode,
  ATTRIBUTION_ROLES,
  ATTRIBUTION_MODES,
} from "../../../drizzle/schema";
import { money, round2, toDbMoney } from "../money";
import Decimal from "decimal.js";

export {
  type AttributionRole,
  type AttributionMode,
  ATTRIBUTION_ROLES,
  ATTRIBUTION_MODES,
};

export interface AttributionParticipantInput {
  userId: number;
  role: AttributionRole;
  sharePct?: string | number | Decimal; // e.g. "0.7000" (70%)
}

export interface SaleAttributionInput {
  repId?: number | null;
  assistedById?: number | null;
  role?: AttributionRole | null;
  mode?: AttributionMode | null;
  splitRatio?: string | null; // e.g. "0.70" or "70/30"
  customSplits?: AttributionParticipantInput[] | null;
  teamPoolId?: number | null;
}

export interface ResolveSaleAttributionInput {
  branchId: number;
  cashierUserId: number;
  attribution?: SaleAttributionInput | null;
  salesRepId?: number | null;
  assistedByUserId?: number | null;
  receptionistUserId?: number | null;
  attributionMode?: AttributionMode | null;
  attributeToUserId?: number | null; // legacy correctSale fallback
  baseAmount: string | Decimal;
}

export interface ResolvedAttributionLine {
  userId: number;
  role: AttributionRole;
  attributionMode: AttributionMode;
  sharePct: string; // decimal(5,4), e.g. "0.7000"
  creditedBaseAmount: string; // decimal(15,2), e.g. "70000.00"
}

export interface ResolvedAttributionPlan {
  primaryUserId: number;
  attributionMode: AttributionMode;
  lines: ResolvedAttributionLine[];
}

/**
 * تحليل نسبة التقسيم المدخلة (مثال: "0.70" أو "70/30" أو "70:30" أو "70")
 */
export function parseSplitRatio(ratioStr?: string | null): {
  primaryPct: Decimal;
  secondaryPct: Decimal;
} {
  if (!ratioStr || typeof ratioStr !== "string") {
    // الافتراضي القياسي لمعارض الرؤية العربية: 70% لبائع الصالة و 30% للكاشير
    return {
      primaryPct: new Decimal("0.7000"),
      secondaryPct: new Decimal("0.3000"),
    };
  }
  const clean = ratioStr.trim();
  if (clean.includes("/") || clean.includes(":")) {
    const parts = clean.split(/[/:]/);
    try {
      const p1 = new Decimal(parts[0]?.trim() || "0");
      const p2 = new Decimal(parts[1]?.trim() || "0");
      const total = p1.plus(p2);
      if (p1.gte(0) && p2.gte(0)) {
        if (total.gt(0)) {
          const primary = p1
            .div(total)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
          const secondary = new Decimal(1)
            .minus(primary)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
          return { primaryPct: primary, secondaryPct: secondary };
        } else if (total.isZero()) {
          return {
            primaryPct: new Decimal("0"),
            secondaryPct: new Decimal("1"),
          };
        }
      }
    } catch {
      // Decimal constructor throws on non-numeric input; fall through safely
    }
  }
  try {
    let val = new Decimal(clean);
    if (val.gt(1)) val = val.div(100);
    if (val.gte(0) && val.lte(1)) {
      const primary = val.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const secondary = new Decimal(1)
        .minus(primary)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      return { primaryPct: primary, secondaryPct: secondary };
    }
  } catch {
    // Decimal constructor throws on non-numeric input; fall through safely
  }
  return {
    primaryPct: new Decimal("0.7000"),
    secondaryPct: new Decimal("0.3000"),
  };
}

/**
 * احتساب وتوزيع الإسناد المالي بدقة متناهية وحفظ فلس الفارق
 */
export function resolveSaleAttribution(
  input: ResolveSaleAttributionInput,
): ResolvedAttributionPlan {
  const baseD = round2(money(input.baseAmount));
  const cashierId = input.cashierUserId;

  // 1. حالة وجود تقسيم مخصص صريح (Custom Splits)
  if (
    input.attribution?.customSplits &&
    input.attribution.customSplits.length > 0
  ) {
    const rawSplits = input.attribution.customSplits;
    let sumPct = new Decimal(0);
    const normalizedSplits = rawSplits.map((s) => {
      const pct = new Decimal(s.sharePct ?? 0).toDecimalPlaces(
        4,
        Decimal.ROUND_HALF_UP,
      );
      if (pct.isNegative() || pct.lt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نسبة إسناد غير مقبولة",
            why: "لا يمكن أن تكون حصة الشريك أو الموظف في الإسناد سالبة.",
            doThis: "تأكد من إدخال نسب مئوية موجبة فقط لا تقل عن صفر.",
          }),
        });
      }
      sumPct = sumPct.plus(pct);
      return { userId: s.userId, role: s.role, pct };
    });

    if (sumPct.minus(1).abs().gt(0.005)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر اعتماد نسب إسناد المبيعات المخصصة",
          why: `مجموع نسب إسناد المبيعات (${sumPct.times(100).toFixed(2)}%) لا يساوي 100% بالضبط.`,
          doThis:
            "تأكد من تعديل نسب المشاركين في الفاتورة بحيث يكون مجموع الحصص 100% تماماً.",
        }),
      });
    }

    let allocatedSum = new Decimal(0);
    const lines: ResolvedAttributionLine[] = [];
    let maxShareIndex = 0;
    let maxShare = new Decimal(-1);

    normalizedSplits.forEach((s, idx) => {
      const credited = round2(baseD.times(s.pct));
      allocatedSum = allocatedSum.plus(credited);
      if (s.pct.gt(maxShare)) {
        maxShare = s.pct;
        maxShareIndex = idx;
      }
      lines.push({
        userId: s.userId,
        role: s.role,
        attributionMode: "SPLIT",
        sharePct: s.pct.toFixed(4),
        creditedBaseAmount: toDbMoney(credited),
      });
    });

    // معالجة فلس الفارق العشري وإضافته للطرف الأكبر
    const delta = baseD.minus(allocatedSum);
    if (!delta.isZero() && lines[maxShareIndex]) {
      const adjusted = money(lines[maxShareIndex].creditedBaseAmount).plus(
        delta,
      );
      lines[maxShareIndex].creditedBaseAmount = toDbMoney(adjusted);
    }

    return {
      primaryUserId: lines[maxShareIndex].userId,
      attributionMode: "SPLIT",
      lines,
    };
  }

  // 2. حالة مجهّز طلبات المتجر (Store Order Fulfiller)
  if (
    input.attribution?.role === "FULFILLER" &&
    (input.attribution.repId || input.salesRepId)
  ) {
    const fulfillerId = input.attribution.repId ?? input.salesRepId!;
    return {
      primaryUserId: fulfillerId,
      attributionMode: "DIRECT",
      lines: [
        {
          userId: fulfillerId,
          role: "FULFILLER",
          attributionMode: "DIRECT",
          sharePct: "1.0000",
          creditedBaseAmount: toDbMoney(baseD),
        },
      ],
    };
  }

  // 3. حالة مسودات الاستقبال (Reception Draft Conversion)
  if (input.receptionistUserId && input.receptionistUserId > 0) {
    const receptionistId = input.receptionistUserId;
    if (receptionistId === cashierId) {
      // موظف الاستقبال هو الكاشير نفسه
      return {
        primaryUserId: cashierId,
        attributionMode: "DIRECT",
        lines: [
          {
            userId: cashierId,
            role: "RECEPTIONIST",
            attributionMode: "DIRECT",
            sharePct: "1.0000",
            creditedBaseAmount: toDbMoney(baseD),
          },
        ],
      };
    }

    const mode: AttributionMode = input.attribution?.mode ?? "SPLIT";
    if (mode === "DIRECT") {
      return {
        primaryUserId: receptionistId,
        attributionMode: "DIRECT",
        lines: [
          {
            userId: receptionistId,
            role: "RECEPTIONIST",
            attributionMode: "DIRECT",
            sharePct: "1.0000",
            creditedBaseAmount: toDbMoney(baseD),
          },
        ],
      };
    }

    // نمط SPLIT الافتراضي للاستقبال: 70% استقبال / 30% كاشير
    const { primaryPct, secondaryPct } = parseSplitRatio(
      input.attribution?.splitRatio,
    );
    const recCredit = round2(baseD.times(primaryPct));
    const cashCredit = round2(baseD.minus(recCredit)); // صيانة فلس الفارق تلقائياً

    return {
      primaryUserId: receptionistId,
      attributionMode: "SPLIT",
      lines: [
        {
          userId: receptionistId,
          role: "RECEPTIONIST",
          attributionMode: "SPLIT",
          sharePct: primaryPct.toFixed(4),
          creditedBaseAmount: toDbMoney(recCredit),
        },
        {
          userId: cashierId,
          role: "CASHIER",
          attributionMode: "SPLIT",
          sharePct: secondaryPct.toFixed(4),
          creditedBaseAmount: toDbMoney(cashCredit),
        },
      ],
    };
  }

  // 4. حالة وجود بائع صالة عرض (Floor Sales Rep)
  const repId =
    input.attribution?.repId ??
    input.salesRepId ??
    input.attributeToUserId ??
    null;
  if (repId && repId > 0) {
    if (repId === cashierId) {
      return {
        primaryUserId: cashierId,
        attributionMode: "DIRECT",
        lines: [
          {
            userId: cashierId,
            role: "CASHIER",
            attributionMode: "DIRECT",
            sharePct: "1.0000",
            creditedBaseAmount: toDbMoney(baseD),
          },
        ],
      };
    }

    const mode: AttributionMode =
      input.attribution?.mode ??
      input.attributionMode ??
      (input.assistedByUserId ? "SPLIT" : "DIRECT");

    if (mode === "SPLIT") {
      const { primaryPct, secondaryPct } = parseSplitRatio(
        input.attribution?.splitRatio,
      );
      const repCredit = round2(baseD.times(primaryPct));
      const secondUserId =
        input.attribution?.assistedById ?? input.assistedByUserId ?? cashierId;
      const secondRole: AttributionRole =
        secondUserId === cashierId ? "CASHIER" : "FLOOR_REP";
      const secondCredit = round2(baseD.minus(repCredit));

      return {
        primaryUserId: repId,
        attributionMode: "SPLIT",
        lines: [
          {
            userId: repId,
            role: "FLOOR_REP",
            attributionMode: "SPLIT",
            sharePct: primaryPct.toFixed(4),
            creditedBaseAmount: toDbMoney(repCredit),
          },
          {
            userId: secondUserId,
            role: secondRole,
            attributionMode: "SPLIT",
            sharePct: secondaryPct.toFixed(4),
            creditedBaseAmount: toDbMoney(secondCredit),
          },
        ],
      };
    }

    if (mode === "POOL") {
      return {
        primaryUserId: repId,
        attributionMode: "POOL",
        lines: [
          {
            userId: repId,
            role: "FLOOR_REP",
            attributionMode: "POOL",
            sharePct: "1.0000",
            creditedBaseAmount: toDbMoney(baseD),
          },
        ],
      };
    }

    // DIRECT mode
    return {
      primaryUserId: repId,
      attributionMode: "DIRECT",
      lines: [
        {
          userId: repId,
          role: "FLOOR_REP",
          attributionMode: "DIRECT",
          sharePct: "1.0000",
          creditedBaseAmount: toDbMoney(baseD),
        },
      ],
    };
  }

  // 5. الحالة الافتراضية التلقائية (Default Fallback: Cashier Direct)
  return {
    primaryUserId: cashierId,
    attributionMode: "DIRECT",
    lines: [
      {
        userId: cashierId,
        role: "CASHIER",
        attributionMode: "DIRECT",
        sharePct: "1.0000",
        creditedBaseAmount: toDbMoney(baseD),
      },
    ],
  };
}

/**
 * حفظ صفوف الإسناد في جدول invoiceAttributions وتحديث رأس الفاتورة داخل معاملة ذرّية
 */
export async function recordInvoiceAttributionsInTx(
  tx: Tx,
  params: {
    branchId: number;
    invoiceId: number;
    plan: ResolvedAttributionPlan;
    teamPoolId?: number | null;
  },
): Promise<void> {
  if (!params.plan.lines || params.plan.lines.length === 0) return;

  await tx.insert(invoiceAttributions).values(
    params.plan.lines.map((l) => ({
      branchId: params.branchId,
      invoiceId: params.invoiceId,
      userId: l.userId,
      role: l.role as never,
      attributionMode: l.attributionMode as never,
      sharePct: l.sharePct,
      creditedBaseAmount: l.creditedBaseAmount,
      teamPoolId: params.teamPoolId ?? null,
    })),
  );
}

/**
 * جلب تفاصيل إسناد فاتورة قائمة
 */
export async function getInvoiceAttributions(tx: Tx, invoiceId: number) {
  return tx
    .select()
    .from(invoiceAttributions)
    .where(eq(invoiceAttributions.invoiceId, invoiceId));
}

/**
 * وراثة الإسناد عند تصحيح الفاتورة (correctSale)
 */
export async function inheritAttributionsForCorrection(
  tx: Tx,
  params: {
    originalInvoiceId: number;
    newInvoiceId: number;
    branchId: number;
    newBaseAmount: string | Decimal;
    fallbackUserId: number;
  },
): Promise<void> {
  const originalAttributions = await getInvoiceAttributions(
    tx,
    params.originalInvoiceId,
  );
  const baseD = round2(money(params.newBaseAmount));

  if (!originalAttributions || originalAttributions.length === 0) {
    // فاتورة تاريخية بلا إسناد: الاعتماد على المستخدم الموروث كـ DIRECT
    await recordInvoiceAttributionsInTx(tx, {
      branchId: params.branchId,
      invoiceId: params.newInvoiceId,
      plan: {
        primaryUserId: params.fallbackUserId,
        attributionMode: "DIRECT",
        lines: [
          {
            userId: params.fallbackUserId,
            role: "CASHIER",
            attributionMode: "DIRECT",
            sharePct: "1.0000",
            creditedBaseAmount: toDbMoney(baseD),
          },
        ],
      },
    });
    return;
  }

  // إعادة تطبيق نفس نسب التقسيم الأصلية على إجمالي الفاتورة المصححة
  let allocatedSum = new Decimal(0);
  const lines: ResolvedAttributionLine[] = [];
  let maxShareIdx = 0;
  let maxShare = new Decimal(-1);

  originalAttributions.forEach((attr, idx) => {
    const pct = new Decimal(attr.sharePct ?? "1.0000");
    const credited = round2(baseD.times(pct));
    allocatedSum = allocatedSum.plus(credited);
    if (pct.gt(maxShare)) {
      maxShare = pct;
      maxShareIdx = idx;
    }
    lines.push({
      userId: Number(attr.userId),
      role: attr.role as AttributionRole,
      attributionMode: attr.attributionMode as AttributionMode,
      sharePct: pct.toFixed(4),
      creditedBaseAmount: toDbMoney(credited),
    });
  });

  const delta = baseD.minus(allocatedSum);
  if (!delta.isZero() && lines[maxShareIdx]) {
    lines[maxShareIdx].creditedBaseAmount = toDbMoney(
      money(lines[maxShareIdx].creditedBaseAmount).plus(delta),
    );
  }

  await recordInvoiceAttributionsInTx(tx, {
    branchId: params.branchId,
    invoiceId: params.newInvoiceId,
    plan: {
      primaryUserId: lines[maxShareIdx]?.userId ?? params.fallbackUserId,
      attributionMode:
        (originalAttributions[0].attributionMode as AttributionMode) ??
        "DIRECT",
      lines,
    },
  });
}
