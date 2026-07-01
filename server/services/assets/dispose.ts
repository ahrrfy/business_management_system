// إخراج من الخدمة (retired) أو استبعاد ببيع/خردة (disposed) مع احتساب الربح/الخسارة.
import Decimal from "decimal.js";
import { and, eq, isNull } from "drizzle-orm";
import { assetCustodyLog, fixedAssets, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { computeDepreciation } from "./depreciation";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";

export interface DisposeInput {
  kind: "retired" | "disposed";
  date: string;
  reason?: string | null;
  value?: string | number | null;
}

/** إخراج من الخدمة (retired) أو استبعاد ببيع/خردة (disposed) مع احتساب الربح/الخسارة. */
export async function disposeAsset(assetId: number, input: DisposeInput, actor: Actor) {
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId);
    if (a.status === "disposed") throw new Error("الأصل مُستبعَد سلفاً");
    await tx
      .update(assetCustodyLog)
      .set({ toDate: input.date })
      .where(and(eq(assetCustodyLog.assetId, assetId), isNull(assetCustodyLog.toDate)));

    // FI-02 (سدّ فجوة الاتّساق، تحقّق عدائي ٢٠/٦): رحّل أيّ إهلاك غير مُرحَّل حتى تاريخ التصرّف قبل
    // الاحتساب ⇒ المتراكم المخزَّن = computeDepreciation(التاريخ).accumulated. بدونه (إن لم يُشغَّل
    // الترحيل الشهري) يَخرج الأصل من الميزانية بقيمة دفترية منفوخة فتتسرّب القيمة من حقوق الملكية بلا
    // اعتراف بمصروف الإهلاك في P&L. dedupeKey DEPR:id:DISP فريد (مرّة واحدة عند التصرّف).
    const accumTarget = money(
      computeDepreciation(
        {
          purchaseValue: a.purchaseValue,
          salvageValue: a.salvageValue ?? "0",
          usefulLifeYears: a.usefulLifeYears,
          depreciationMethod: (a.depreciationMethod as "sl" | "db") ?? "sl",
          purchaseDate: a.purchaseDate as unknown as string,
          status: a.status,
          disposalDate: input.date,
        },
        new Date(input.date),
      ).accumulated,
    );
    const catchUp = accumTarget.sub(money(a.accumulatedDepreciation ?? "0"));
    if (catchUp.gt(0)) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: a.branchId != null ? Number(a.branchId) : (actor.branchId || null),
        cost: catchUp,
        profit: catchUp.neg(),
        amount: catchUp,
        entryDate: new Date(input.date),
        dedupeKey: `DEPR:${assetId}:DISP`,
        notes: `إهلاك حتى التصرّف لأصل ${a.code}`,
      });
      await tx.update(fixedAssets).set({ accumulatedDepreciation: toDbMoney(accumTarget) }).where(eq(fixedAssets.id, assetId));
    }

    // FA-02 (تدقيق ٢٠/٦، قرار المالك): التصرّف يُرحَّل للدفتر — نقد + ربح/خسارة (كانا يُهمَلان: نقد غير
    // مرئيّ والربح/الخسارة يُحسَب للعرض فقط). NBV عند تاريخ التصرّف (computeDepreciation يَتوقّف عند
    // disposalDate). الربح/الخسارة = المتحصّل − NBV. (الاتساق الكامل مع الميزانية يكتمل مع FI-02 قيد الإهلاك.)
    const nbv = money(
      computeDepreciation(
        {
          purchaseValue: a.purchaseValue,
          salvageValue: a.salvageValue ?? "0",
          usefulLifeYears: a.usefulLifeYears,
          depreciationMethod: (a.depreciationMethod as "sl" | "db") ?? "sl",
          purchaseDate: a.purchaseDate as unknown as string,
          status: a.status,
          disposalDate: input.date,
        },
        new Date(input.date),
      ).bookValue,
    );
    const proceeds = input.kind === "disposed" ? money(input.value ?? "0") : new Decimal(0);
    const branchId = a.branchId != null ? Number(a.branchId) : (actor.branchId || null);
    const entryDate = new Date(input.date);

    // (أ) النقد المتحصّل: إيصال IN (خزينة) + قيد PAYMENT_IN ⇒ النقد مرئيّ في الدفتر والخزينة (لا يُجيَّب).
    if (proceeds.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        branchId,
        cashBucket: "TREASURY",
        direction: "IN",
        amount: toDbMoney(proceeds),
        paymentMethod: "CASH",
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId,
        receiptId,
        amount: proceeds,
        entryDate,
        dedupeKey: `ASSET_DISP:${assetId}`,
        notes: `متحصّل تصرّف بأصل ${a.code}`,
      });
    }

    // (ب) الربح/الخسارة = المتحصّل − NBV (موجب=ربح إيراد، سالب=خسارة) ⇒ يَظهر في P&L.
    //     retired (بلا متحصّل) ⇒ خسارة = −NBV (شطب القيمة الدفترية المتبقّية).
    const gain = proceeds.minus(nbv);
    if (!gain.isZero()) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId,
        revenue: gain,
        profit: gain,
        amount: gain,
        entryDate,
        dedupeKey: `ASSET_DISP_PL:${assetId}`,
        notes: `ربح/خسارة تصرّف بأصل ${a.code} (متحصّل ${proceeds.toFixed(2)} − NBV ${nbv.toFixed(2)})`,
      });
    }

    await tx
      .update(fixedAssets)
      .set({
        status: input.kind,
        disposalDate: input.date,
        disposalReason: input.reason ?? null,
        disposalValue: input.kind === "disposed" ? toDbMoney(input.value ?? "0") : null,
        custodianId: null,
      })
      .where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId);
}
