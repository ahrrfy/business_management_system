// G-م٢: منح هدية صادرة للعميل. تحاكي expenseService.createStockExpenseTx: applyMovement(OUT, GIFT_OUT)
// + postEntry(GIFT_OUT: revenue=0, profit=-cost, amount=cost, **بلا invoiceId** ⇒ خارج وعاء العمولة تلقائياً).
// لا بيع، لا نقد للصندوق، لا ذمة على العميل. حوكمة SOD (منع الإساءة): فوق عتبة التكلفة أو من غير مدير ⇒
// PENDING_APPROVAL بلا أثر، يعتمدها **مدير آخر** (approveGift، SOD-04: المعتمِد ≠ المنشئ، admin مُستثنى).
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { branches, customers, giftVoucherLines, giftVouchers, productVariants } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement, convertToBaseQuantity, isBundleVariant, isServiceVariant } from "../inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { money, round2 } from "../money";
import { withTx, type Actor } from "../tx";
import { ensureAndLockBranchStock, nextGiftNumber } from "./helpers";

/** عتبة تكلفة الهدية الصادرة قبل إلزام اعتماد مدير آخر (د.ع). قابلة للضبط لاحقاً عبر الإعدادات. */
export const GIFT_APPROVAL_THRESHOLD = "50000";

export interface OutboundGiftLineInput {
  variantId: number;
  productUnitId: number;
  quantity: number;
  refSalePrice?: string | null;
}
export interface CreateOutboundGiftInput {
  branchId: number;
  customerId?: number | null;
  giftType?: string | null;
  reason?: string | null;
  notes?: string | null;
  clientRequestId?: string | null; // حماية من الازدواج (إعادة إرسالٍ بعد فقد الردّ ⇒ لا خصم/قيد مزدوج)
  lines: OutboundGiftLineInput[];
}
export interface OutboundGiftResult {
  giftVoucherId: number;
  giftNumber: string;
  status: "PENDING_APPROVAL" | "DELIVERED";
  totalCost: string;
  pending: boolean;
}

type Converted = { variantId: number; productUnitId: number; quantity: string; baseQuantity: number; refSalePrice: string | null };

/** يحوّل الأسطر لوحدة الأساس ويمنع البكج/الخدميّ (لا مخزون ذاتيّ). */
async function convertLines(tx: Tx, lines: OutboundGiftLineInput[]): Promise<Converted[]> {
  const out: Converted[] = [];
  for (const ln of lines) {
    if (!(ln.quantity > 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الهدية يجب أن تكون موجبة" });
    if (await isBundleVariant(tx, ln.variantId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُمنَح هدية لمنتج بكج (مركّب) — امنح مكوّناته المخزونية." });
    }
    if (await isServiceVariant(tx, ln.variantId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُمنَح هدية لمنتج خدميّ (بلا مخزون)." });
    }
    const conv = await convertToBaseQuantity(tx, ln.productUnitId, ln.quantity, ln.variantId);
    out.push({
      variantId: ln.variantId,
      productUnitId: ln.productUnitId,
      quantity: money(ln.quantity).toFixed(4),
      baseQuantity: conv.baseQuantity,
      refSalePrice: ln.refSalePrice ?? null,
    });
  }
  return out;
}

/** يقفل المتغيّرات تصاعدياً ويقرأ WAVG (costPrice لكل وحدة أساس). يعيد خريطة التكلفة. */
async function lockCosts(tx: Tx, variantIds: number[]): Promise<Map<number, string>> {
  const rows = await tx
    .select({ id: productVariants.id, cost: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds))
    .for("update");
  return new Map<number, string>(rows.map((v) => [Number(v.id), String(v.cost ?? "0")]));
}

/** يطبّق الأثر: خصم مخزون OUT لكل صنف (تصاعدياً) + قيد GIFT_OUT واحد (revenue=0, profit=-cost, بلا invoiceId). */
async function applyOutboundEffect(
  tx: Tx,
  giftVoucherId: number,
  branchId: number,
  customerId: number | null,
  qtyByVariant: Map<number, number>,
  totalCost: string,
  actor: Actor,
): Promise<void> {
  const variantIds = Array.from(qtyByVariant.keys()).sort((a, b) => a - b);
  for (const variantId of variantIds) {
    await applyMovement(tx, {
      variantId,
      branchId,
      baseQuantity: qtyByVariant.get(variantId)!,
      movementType: "OUT",
      referenceType: "GIFT_OUT",
      referenceId: giftVoucherId,
      createdBy: actor.userId,
    });
  }
  const total = money(totalCost);
  // قيد GIFT_OUT: مصروف هدايا وترويج بالكلفة — بلا invoiceId ⇒ لا يظهر في وعاء عمولة أي بائع.
  await postEntry(tx, {
    entryType: "GIFT_OUT",
    branchId,
    customerId: customerId ?? undefined,
    cost: total,
    amount: total,
    revenue: money(0),
    profit: round2(money(0).minus(total)),
    dedupeKey: `GIFT:${giftVoucherId}`,
    notes: "هدية صادرة للعميل",
  });
}

export async function createOutboundGift(input: CreateOutboundGiftInput, actor: Actor): Promise<OutboundGiftResult> {
  if (!input.lines?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أضف صنفاً واحداً على الأقل للهدية" });

  return withTx(async (tx) => {
    const b = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
    if (input.customerId != null) {
      const c = (await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    }

    // حماية الازدواج (تدقيق Codex P1): إعادة إرسالٍ بنفس clientRequestId ⇒ تُعاد نتيجة السند الأصليّ
    // بلا خصمٍ ولا قيدٍ ثانٍ (auto-post) ولا سندٍ معلَّقٍ مكرَّر. القيد الفريد يُفشِل السباق المتزامن.
    const replayId = await findIdempotentRefId(tx, "gifts.outbound", input.clientRequestId);
    if (replayId) {
      const ex = (await tx
        .select({ n: giftVouchers.giftNumber, st: giftVouchers.status, tc: giftVouchers.totalCost })
        .from(giftVouchers)
        .where(eq(giftVouchers.id, replayId))
        .limit(1))[0];
      const status = (ex?.st === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "DELIVERED") as "PENDING_APPROVAL" | "DELIVERED";
      return { giftVoucherId: replayId, giftNumber: ex?.n ?? "", status, totalCost: String(ex?.tc ?? "0"), pending: status === "PENDING_APPROVAL" };
    }

    const converted = await convertLines(tx, input.lines);
    const variantIds = Array.from(new Set(converted.map((c) => c.variantId))).sort((a, b) => a - b);
    // قفل branchStock قبل productVariants (توحيد الترتيب مع الوارد/الشراء ⇒ لا deadlock — تدقيق Codex P1).
    await ensureAndLockBranchStock(tx, variantIds, input.branchId);
    const costMap = await lockCosts(tx, variantIds);

    // تكلفة كل سطر (WAVG لكل وحدة أساس × كمية الأساس) + الإجمالي + تجميع الكمية لكل صنف.
    let total = money(0);
    const qtyByVariant = new Map<number, number>();
    const perLine = converted.map((c) => {
      const unitBaseCost = money(costMap.get(c.variantId) ?? "0");
      const lineCost = round2(unitBaseCost.times(c.baseQuantity));
      total = total.plus(lineCost);
      qtyByVariant.set(c.variantId, (qtyByVariant.get(c.variantId) ?? 0) + c.baseQuantity);
      return { ...c, unitCostSnapshot: round2(unitBaseCost).toFixed(2), lineCost: lineCost.toFixed(2) };
    });
    const totalCost = round2(total);

    // حوكمة SOD: admin يُنجز مباشرةً؛ المدير يُنجز تحت العتبة فقط؛ غيرهما (محاسب/مخزن) يلزمه اعتماد دائماً.
    const isAdmin = actor.role === "admin";
    const isManager = actor.role === "manager";
    const overThreshold = totalCost.gt(money(GIFT_APPROVAL_THRESHOLD));
    const needsApproval = !isAdmin && (overThreshold || !isManager);

    const giftNumber = await nextGiftNumber(tx, input.branchId);
    const insHead = await tx.insert(giftVouchers).values({
      giftNumber,
      direction: "OUT",
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      giftType: input.giftType?.trim() || null,
      reason: input.reason?.trim() || null,
      sellable: true,
      status: needsApproval ? "PENDING_APPROVAL" : "DELIVERED",
      totalCost: totalCost.toFixed(2),
      notes: input.notes?.trim() || null,
      createdBy: actor.userId,
      approvedBy: needsApproval ? null : actor.userId,
      approvedAt: needsApproval ? null : new Date(),
    });
    const giftVoucherId = extractInsertId(insHead);
    if (input.clientRequestId) await recordIdempotencyKey(tx, "gifts.outbound", input.clientRequestId, giftVoucherId);

    for (const c of perLine) {
      await tx.insert(giftVoucherLines).values({
        giftVoucherId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitCostSnapshot: c.unitCostSnapshot,
        lineCost: c.lineCost,
        refSalePrice: c.refSalePrice,
      });
    }

    // أثرٌ فوريّ فقط للمُنجَز (auto-post). المعلَّق: صفر أثر حتى الاعتماد.
    if (!needsApproval) {
      await applyOutboundEffect(tx, giftVoucherId, input.branchId, input.customerId ?? null, qtyByVariant, totalCost.toFixed(2), actor);
    }

    return {
      giftVoucherId,
      giftNumber,
      status: needsApproval ? "PENDING_APPROVAL" : "DELIVERED",
      totalCost: totalCost.toFixed(2),
      pending: needsApproval,
    };
  });
}

export interface ApproveGiftResult {
  giftVoucherId: number;
  status: "DELIVERED";
  totalCost: string;
}

/** اعتماد هدية صادرة معلَّقة (SOD-04). يعيد فحص التكلفة تحت القفل (قد تتغيّر WAVG بين الإنشاء والاعتماد). */
export async function approveGift(giftId: number, actor: Actor): Promise<ApproveGiftResult> {
  const isAdmin = actor.role === "admin";
  const isManager = actor.role === "manager";
  if (!isAdmin && !isManager) throw new TRPCError({ code: "FORBIDDEN", message: "اعتماد الهدية من صلاحية المدير فقط" });

  return withTx(async (tx) => {
    const gift = (await tx.select().from(giftVouchers).where(eq(giftVouchers.id, giftId)).for("update").limit(1))[0];
    if (!gift) throw new TRPCError({ code: "NOT_FOUND", message: "سند الهدية غير موجود" });
    if (gift.direction !== "OUT") throw new TRPCError({ code: "BAD_REQUEST", message: "الاعتماد للهدايا الصادرة فقط" });
    if (gift.status !== "PENDING_APPROVAL") throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن اعتماد هدية حالتها ${gift.status}` });
    // عزل الفرع: غير الأدمن يعتمد فرعه فقط.
    if (!isAdmin && Number(gift.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الهدية لا تخصّ فرعك" });
    }
    // SOD-04: المُنشئ لا يعتمد هديته (admin مُستثنى للتصحيح الإداري).
    if (!isAdmin && Number(gift.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد هدية أنشأتها بنفسك — يلزم مدير آخر (فصل المهام)." });
    }

    const lineRows = await tx.select().from(giftVoucherLines).where(eq(giftVoucherLines.giftVoucherId, giftId));
    if (!lineRows.length) throw new TRPCError({ code: "BAD_REQUEST", message: "سند الهدية بلا أسطر" });
    const variantIds = Array.from(new Set(lineRows.map((l) => Number(l.variantId)))).sort((a, b) => a - b);
    // قفل branchStock قبل productVariants (توحيد الترتيب — تدقيق Codex P1).
    await ensureAndLockBranchStock(tx, variantIds, Number(gift.branchId));
    const costMap = await lockCosts(tx, variantIds);

    // إعادة فحص التكلفة تحت القفل (WAVG قد تتغيّر) + تحديث لقطات كل سطر بمعرّفه + تجميع الكمية.
    let total = money(0);
    const qtyByVariant = new Map<number, number>();
    for (const l of lineRows) {
      const vId = Number(l.variantId);
      const baseQty = Number(l.baseQuantity);
      const unitBaseCost = money(costMap.get(vId) ?? "0");
      const lineCost = round2(unitBaseCost.times(baseQty));
      total = total.plus(lineCost);
      qtyByVariant.set(vId, (qtyByVariant.get(vId) ?? 0) + baseQty);
      await tx
        .update(giftVoucherLines)
        .set({ unitCostSnapshot: round2(unitBaseCost).toFixed(2), lineCost: lineCost.toFixed(2) })
        .where(eq(giftVoucherLines.id, Number(l.id)));
    }
    const totalCost = round2(total);

    await applyOutboundEffect(
      tx,
      giftId,
      Number(gift.branchId),
      gift.customerId != null ? Number(gift.customerId) : null,
      qtyByVariant,
      totalCost.toFixed(2),
      actor,
    );

    await tx
      .update(giftVouchers)
      .set({ status: "DELIVERED", totalCost: totalCost.toFixed(2), approvedBy: actor.userId, approvedAt: new Date() })
      .where(eq(giftVouchers.id, giftId));

    return { giftVoucherId: giftId, status: "DELIVERED", totalCost: totalCost.toFixed(2) };
  });
}
