// خدمة تحويلات المخزون بخطوتين (١٤/٧/٢٠٢٦): إرسال ← «بالطريق» ← استلام بمطابقة فعلية.
//
// النموذج المخزني: الإرسال يكتب TRANSFER_OUT من المصدر فوراً (البضاعة خرجت فعلاً)، ولا
// يُكتب TRANSFER_IN إلا عند الاستلام وبالكمية المستلَمة فقط ⇒ ما هو «بالطريق» لا يظهر في
// رصيد أي فرع (لا يُباع مرّتين ولا يُجرَد وهماً). العجز (المرسَل − المستلَم) يبقى موثَّقاً
// على سطر السند مع ملاحظة إلزامية — مجموع مخزون النظام ينقص به فعلاً (خسارة نقل حقيقية).
// عجز المملوك: خسائر مقابل INVENTORY. عجز الأمانة: خسائر مقابل التزام المودِع بلا لمس INVENTORY.
//
// الإلغاء (سند بالطريق فقط): يعيد الكمية كاملة للمصدر بحركة TRANSFER_IN عكسية ويغلق السند.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { branches, branchStock, inventoryMovements, productVariants, products, stockTransferLines, stockTransfers, suppliers, users } from "../../drizzle/schema";
import type { Tx } from "../db";
import { getDb } from "../db";
import { applyMovement } from "./inventoryService";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "./idempotency";
import { adjustSupplierBalance, postEntry } from "./ledgerService";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { money } from "./money";
import { extractInsertId } from "../lib/insertId";

export type TransferActor = { userId: number; role: string; branchId: number | null };

const COST_SNAPSHOT_RE = /\[COST_SNAPSHOT:([0-9]+(?:\.[0-9]{1,2})?)\]/;

function transferCostSnapshot(notes: string | null | undefined): string | null {
  const match = notes?.match(COST_SNAPSHOT_RE);
  return match ? money(match[1]).toFixed(2) : null;
}

/** المالك/الأدمن فقط يتصرّفان على أيّ فرع (owner مُطبَّع ⇒ admin)؛ مدير الفرع وغيره مقيَّدون بفرعهم
 *  المُسنَد — قرار المالك ١٢/٨ (عزل مدير الفرع: لا استلام/إلغاء تحويلٍ من فرعٍ ليس فرعه). */
function isElevated(actor: TransferActor): boolean {
  return actor.role === "admin";
}

function assertBranchActor(actor: TransferActor, branchId: number, message: string): void {
  if (isElevated(actor)) return;
  if (actor.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  if (Number(actor.branchId) !== Number(branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
}

export interface CreateTransferArgs {
  fromBranchId: number;
  toBranchId: number;
  items: Array<{ variantId: number; baseQuantity: number }>;
  reason?: string;
  notes?: string;
  clientRequestId?: string;
  createdBy: number;
}

/**
 * إنشاء سند تحويل + خصم المصدر (TRANSFER_OUT لكل سطر) داخل معاملة واحدة — إمّا يخرج السند
 * كاملاً «بالطريق» أو لا شيء (نقص مخزون بأي سطر = ROLLBACK للكل).
 */
export async function createStockTransfer(tx: Tx, a: CreateTransferArgs) {
  if (a.fromBranchId === a.toBranchId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التحويل لنفس الفرع" });
  }
  if (!a.items.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أضف صنفاً واحداً على الأقل" });
  }
  const seen = new Set<number>();
  for (const it of a.items) {
    if (!Number.isInteger(it.baseQuantity) || it.baseQuantity <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً" });
    }
    if (seen.has(it.variantId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "صنف مكرّر في السند — ادمج كميته في سطر واحد." });
    }
    seen.add(it.variantId);
  }

  // idempotency: نقرة مزدوجة/إعادة شبكية بنفس المفتاح تعيد السند الأول بدل خصم المصدر مرّتين.
  // A clientRequestId identifies one *specific* dispatch.  Replaying it with a
  // different destination or line quantities must not silently return the
  // earlier transfer: that would make the caller believe its new request was
  // fulfilled while the stock movement belongs to another document.
  const createRequestHash = a.clientRequestId
    ? idempotencyHash({
        fromBranchId: a.fromBranchId,
        toBranchId: a.toBranchId,
        items: [...a.items]
          .map((item) => ({ variantId: item.variantId, baseQuantity: item.baseQuantity }))
          .sort((left, right) => left.variantId - right.variantId),
        reason: a.reason ?? null,
        notes: a.notes?.trim() || null,
      })
    : null;
  const existing = await checkIdempotency(
    tx,
    "inventory.transferCreate",
    a.clientRequestId,
    createRequestHash,
  );
  if (existing != null) {
    const doc = (await tx.select().from(stockTransfers).where(eq(stockTransfers.id, existing)).limit(1))[0];
    return { transferId: existing, transferNumber: doc?.transferNumber ?? "", lines: a.items.length, idempotentReplay: true as const };
  }

  const totalSentBase = a.items.reduce((s, it) => s + it.baseQuantity, 0);
  const res = await tx.insert(stockTransfers).values({
    // placeholder فريد ثم يُستبدل برقمٍ مبنيّ على id (حتمي، بلا سباق عدّادات).
    transferNumber: `PENDING-${crypto.randomUUID().slice(0, 16)}`,
    fromBranchId: a.fromBranchId,
    toBranchId: a.toBranchId,
    reason: a.reason ?? null,
    notes: a.notes?.trim() || null,
    totalSentBase,
    createdBy: a.createdBy,
  });
  const transferId = extractInsertId(res);
  const d = new Date();
  const transferNumber = `TRF-${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}-${transferId}`;
  await tx.update(stockTransfers).set({ transferNumber }).where(eq(stockTransfers.id, transferId));

  // ترتيب حتمي بالمتغيّر ⇒ سندان متزامنان يقفلان الصفوف بنفس الترتيب (لا deadlock).
  const sorted = [...a.items].sort((x, y) => x.variantId - y.variantId);
  const sortedVariantIds = sorted.map((it) => it.variantId);
  // نفس ترتيب أقفال WAVG في الشراء/الإنتاج: أرصدة الصنف عالمياً ثم صف التكلفة.
  // بذلك تكون لقطة الإرسال هي التكلفة الفعلية لحظة خروج البضاعة، لا قراءة سبقت استلاماً متزامناً.
  await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(inArray(branchStock.variantId, sortedVariantIds))
    .orderBy(asc(branchStock.variantId))
    .for("update");
  const costRows = await tx
    .select({ id: productVariants.id, costPrice: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, sortedVariantIds))
    .orderBy(asc(productVariants.id))
    .for("update");
  const costAtDispatch = new Map(costRows.map((row) => [Number(row.id), money(row.costPrice ?? "0").toFixed(2)]));
  for (const it of sorted) {
    const costSnapshot = costAtDispatch.get(it.variantId);
    if (costSnapshot == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: `الصنف #${it.variantId} غير موجود` });
    }
    await tx.insert(stockTransferLines).values({
      transferId,
      variantId: it.variantId,
      quantitySent: it.baseQuantity,
    });
    await applyMovement(tx, {
      variantId: it.variantId,
      branchId: a.fromBranchId,
      baseQuantity: it.baseQuantity,
      movementType: "TRANSFER_OUT",
      relatedBranchId: a.toBranchId,
      referenceType: "TRANSFER",
      referenceId: transferId,
      notes: `سند تحويل ${transferNumber} — بالطريق إلى الفرع الوجهة [COST_SNAPSHOT:${costSnapshot}]`,
      createdBy: a.createdBy,
    });
  }

  if (a.clientRequestId) {
    await recordIdempotencyKey(tx, "inventory.transferCreate", a.clientRequestId, transferId, createRequestHash);
  }
  return { transferId, transferNumber, lines: a.items.length, idempotentReplay: false as const };
}

export interface ReceiveTransferArgs {
  transferId: number;
  lines: Array<{ lineId: number; quantityReceived: number; note?: string }>;
  receiveNotes?: string;
  clientRequestId?: string;
  actor: TransferActor;
}

/**
 * استلام السند في الفرع الوجهة بمطابقة فعلية: لكل سطر كمية مستلَمة 0..المرسَل، وملاحظة
 * إلزامية عند وجود فرق. يُكتب TRANSFER_IN بالمستلَم فقط؛ العجز يبقى على السند (خسارة نقل).
 * استلام واحد نهائي يغلق السند (لا استلام على دفعات — فرعان بنفس المدينة).
 */
export async function receiveStockTransfer(tx: Tx, a: ReceiveTransferArgs) {
  // Receipt idempotency must be bound to both this transfer and the exact
  // received quantities.  A reused key used to return a false success for a
  // different transfer (or a changed shortage declaration), leaving that
  // transfer unreceived without alerting the cashier.
  const receiveRequestHash = a.clientRequestId
    ? idempotencyHash({
        transferId: a.transferId,
        lines: [...a.lines]
          .map((line) => ({
            lineId: line.lineId,
            quantityReceived: line.quantityReceived,
            note: line.note?.trim() || null,
          }))
          .sort((left, right) => left.lineId - right.lineId),
        receiveNotes: a.receiveNotes?.trim() || null,
      })
    : null;
  const replay = await checkIdempotency(
    tx,
    "inventory.transferReceive",
    a.clientRequestId,
    receiveRequestHash,
  );
  if (replay != null) {
    // Older records did not carry a hash, so retain a document-identity guard
    // while they remain in the database.
    if (replay !== a.transferId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "معرّف طلب الاستلام استُخدم لسند تحويل آخر — استعمل معرّفاً جديداً",
      });
    }
    return { transferId: a.transferId, idempotentReplay: true as const, discrepancyUnits: 0 };
  }

  const doc = (
    await tx.select().from(stockTransfers).where(eq(stockTransfers.id, a.transferId)).for("update").limit(1)
  )[0];
  if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "سند التحويل غير موجود" });
  assertBranchActor(a.actor, Number(doc.toBranchId), "استلام التحويل حصريّ لموظفي الفرع الوجهة");
  if (doc.status !== "IN_TRANSIT") {
    throw new TRPCError({ code: "CONFLICT", message: `السند ${doc.transferNumber} ليس بالطريق (حالته الحالية لا تقبل الاستلام)` });
  }

  const docLines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, a.transferId));
  const byId = new Map(docLines.map((l) => [Number(l.id), l]));
  if (a.lines.length !== docLines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يجب تسجيل كمية مستلَمة لكل أسطر السند (المطابقة الكاملة شرط الإقفال)" });
  }
  const seenLine = new Set<number>();
  for (const l of a.lines) {
    const dl = byId.get(l.lineId);
    if (!dl || seenLine.has(l.lineId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سطر استلام لا يطابق أسطر السند" });
    }
    seenLine.add(l.lineId);
    if (!Number.isInteger(l.quantityReceived) || l.quantityReceived < 0 || l.quantityReceived > dl.quantitySent) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الكمية المستلَمة يجب أن تكون بين 0 و${dl.quantitySent} (المرسَل)` });
    }
    if (l.quantityReceived !== dl.quantitySent && !l.note?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سطر بفارق عن المرسَل يتطلّب ملاحظة تشرح العجز" });
    }
  }

  // ترتيب حتمي بالمتغيّر (نفس منطق الإنشاء) لتفادي deadlock مع سندات متزامنة.
  const sortedIn = [...a.lines].sort((x, y) => Number(byId.get(x.lineId)!.variantId) - Number(byId.get(y.lineId)!.variantId));
  let totalReceivedBase = 0;
  const shortages: Array<{ variantId: number; qty: number }> = [];
  for (const l of sortedIn) {
    const dl = byId.get(l.lineId)!;
    totalReceivedBase += l.quantityReceived;
    if (l.quantityReceived < dl.quantitySent) {
      shortages.push({ variantId: Number(dl.variantId), qty: dl.quantitySent - l.quantityReceived });
    }
    if (l.quantityReceived > 0) {
      await applyMovement(tx, {
        variantId: Number(dl.variantId),
        branchId: Number(doc.toBranchId),
        baseQuantity: l.quantityReceived,
        movementType: "TRANSFER_IN",
        relatedBranchId: Number(doc.fromBranchId),
        referenceType: "TRANSFER",
        referenceId: a.transferId,
        notes:
          l.quantityReceived === dl.quantitySent
            ? `استلام سند ${doc.transferNumber} — مطابق`
            : `استلام سند ${doc.transferNumber} — عجز ${dl.quantitySent - l.quantityReceived}: ${l.note?.trim()}`,
        createdBy: a.actor.userId,
      });
    }
    await tx
      .update(stockTransferLines)
      .set({ quantityReceived: l.quantityReceived, note: l.note?.trim() || null })
      .where(eq(stockTransferLines.id, l.lineId));
  }

  // قيد خسارة نقل بقيمة التكلفة (قرار مالك ١٤/٧): العجز خرج من رصيد المصدر ولم يصل الوجهة ⇒
  // مصروف حقيقي في P&L (نمط قيد تسوية الجرد: cost موجب/profit سالب، بلا نقد). يُنسب لفرع
  // **المصدر** — البضاعة كانت في عهدته حتى تسليمها، وعنده يبدأ تحقيق العجز. dedupeKey يمنع الازدواج.
  if (shortages.length) {
    const ids = shortages.map((s) => s.variantId);
    const dispatchMoves = await tx
      .select({ variantId: inventoryMovements.variantId, notes: inventoryMovements.notes })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.referenceType, "TRANSFER"),
          eq(inventoryMovements.referenceId, a.transferId),
          eq(inventoryMovements.movementType, "TRANSFER_OUT"),
          inArray(inventoryMovements.variantId, ids),
        ),
      );
    const costOf = new Map<number, string>();
    for (const move of dispatchMoves) {
      const snapshot = transferCostSnapshot(move.notes);
      if (snapshot != null) costOf.set(Number(move.variantId), snapshot);
    }
    for (const s of shortages) {
      if (!costOf.has(s.variantId)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `لا يمكن تقييم عجز الصنف #${s.variantId}: سند الإرسال لا يحتوي لقطة تكلفة موثّقة`,
        });
      }
    }
    // لقطة القيمة نفسها من الإرسال، لكن الملكية تُحسم تحت قفل بعد أقفال branchStock التي أخذتها
    // حركات الاستلام. هذا يحافظ على ترتيب WAVG (stock ثم variant) ويمنع تبديل وسم الأمانة أثناء القيد.
    const ownershipRows = await tx
      .select({
        variantId: productVariants.id,
        isConsignment: products.isConsignment,
        consignorId: products.consignorId,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, ids))
      .orderBy(asc(productVariants.id))
      .for("update");
    const ownershipByVariant = new Map(ownershipRows.map((row) => [Number(row.variantId), row]));
    let ownedLossValue = money(0);
    const consignmentLossByConsignor = new Map<number, ReturnType<typeof money>>();
    for (const shortage of shortages) {
      const ownership = ownershipByVariant.get(shortage.variantId);
      if (!ownership) {
        throw new TRPCError({ code: "NOT_FOUND", message: `الصنف #${shortage.variantId} غير موجود` });
      }
      const value = money(costOf.get(shortage.variantId) ?? "0").times(shortage.qty);
      if (!ownership.isConsignment) {
        ownedLossValue = ownedLossValue.plus(value);
        continue;
      }
      if (ownership.consignorId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `صنف الأمانة #${shortage.variantId} بلا مودِع منسوب — لا يمكن إثبات عجز التحويل`,
        });
      }
      const consignorId = Number(ownership.consignorId);
      consignmentLossByConsignor.set(
        consignorId,
        (consignmentLossByConsignor.get(consignorId) ?? money(0)).plus(value),
      );
    }

    if (!ownedLossValue.isZero()) {
      const postingSourceComponents = {
        roleDebits: { LOSSES: ownedLossValue },
        roleCredits: { INVENTORY: ownedLossValue },
      };
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(doc.fromBranchId),
        cost: ownedLossValue,
        profit: ownedLossValue.neg(),
        amount: money(0),
        dedupeKey: `TRANSFER_LOSS:${a.transferId}`,
        notes: `عجز نقل — سند ${doc.transferNumber} (${shortages.reduce((s, x) => s + x.qty, 0)} وحدة)`,
        postingIntent: createPostingIntent(
          "ADJUST_INVENTORY_LOSS",
          "ADJUST",
          [debitLine("LOSSES", ownedLossValue), creditLine("INVENTORY", ownedLossValue)],
          {
            roleDebits: { LOSSES: ownedLossValue },
            roleCredits: { INVENTORY: ownedLossValue },
          },
        ),
        postingSourceComponents,
      });
    }

    // عجز الأمانة لا يخفض INVENTORY محاسبياً لأنها ليست أصلاً للمكتبة: Dr LOSSES / Cr التزام
    // المودِع، مع رفع ذمته. نقفل المودعين تصاعدياً قبل أي تحديثٍ لمنع deadlock في سند متعدد المودعين.
    const consignorIds = Array.from(consignmentLossByConsignor.keys()).sort((a, b) => a - b);
    if (consignorIds.length) {
      const lockedConsignors = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(inArray(suppliers.id, consignorIds))
        .orderBy(asc(suppliers.id))
        .for("update");
      if (lockedConsignors.length !== consignorIds.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "تعذّر إثبات عجز الأمانة: أحد المودعين غير موجود",
        });
      }
    }
    for (const consignorId of consignorIds) {
      const amount = consignmentLossByConsignor.get(consignorId)!;
      if (amount.lte(0)) continue;
      const postingSourceComponents = {
        roleDebits: { LOSSES: amount },
        roleCredits: { CONSIGNMENT_PAYABLE: amount },
      };
      await postEntry(tx, {
        entryType: "PURCHASE",
        supplierId: consignorId,
        invoiceId: null,
        branchId: Number(doc.fromBranchId),
        amount,
        cost: amount,
        profit: amount.neg(),
        dedupeKey: `CONSIG:TRANSFER_SHORT:${a.transferId}:${consignorId}`,
        notes: `عجز نقل أمانة — سند ${doc.transferNumber}`,
        postingIntent: createPostingIntent(
          "PURCHASE_CONSIGNMENT_SHORTAGE",
          "PURCHASE",
          [debitLine("LOSSES", amount), creditLine("CONSIGNMENT_PAYABLE", amount)],
          {
            roleDebits: { LOSSES: amount },
            roleCredits: { CONSIGNMENT_PAYABLE: amount },
          },
        ),
        postingSourceComponents,
      });
      await adjustSupplierBalance(tx, consignorId, amount);
    }
  }

  await tx
    .update(stockTransfers)
    .set({
      status: "RECEIVED",
      totalReceivedBase,
      receivedBy: a.actor.userId,
      receivedAt: new Date(),
      receiveNotes: a.receiveNotes?.trim() || null,
    })
    .where(eq(stockTransfers.id, a.transferId));

  if (a.clientRequestId) {
    await recordIdempotencyKey(tx, "inventory.transferReceive", a.clientRequestId, a.transferId, receiveRequestHash);
  }
  return {
    transferId: a.transferId,
    idempotentReplay: false as const,
    discrepancyUnits: Number(doc.totalSentBase) - totalReceivedBase,
  };
}

/** إلغاء سند «بالطريق» (المرسل تراجع/البضاعة رجعت): يعيد الكمية كاملة لرصيد المصدر ويغلق السند. */
export async function cancelStockTransfer(tx: Tx, a: { transferId: number; actor: TransferActor }) {
  const doc = (
    await tx.select().from(stockTransfers).where(eq(stockTransfers.id, a.transferId)).for("update").limit(1)
  )[0];
  if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "سند التحويل غير موجود" });
  assertBranchActor(a.actor, Number(doc.fromBranchId), "إلغاء التحويل حصريّ لموظفي الفرع المرسل");
  if (doc.status !== "IN_TRANSIT") {
    throw new TRPCError({ code: "CONFLICT", message: "لا يُلغى إلا سندٌ ما يزال بالطريق" });
  }

  const docLines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, a.transferId));
  const sorted = [...docLines].sort((x, y) => Number(x.variantId) - Number(y.variantId));
  for (const dl of sorted) {
    await applyMovement(tx, {
      variantId: Number(dl.variantId),
      branchId: Number(doc.fromBranchId),
      baseQuantity: dl.quantitySent,
      movementType: "TRANSFER_IN",
      relatedBranchId: Number(doc.toBranchId),
      referenceType: "TRANSFER",
      referenceId: a.transferId,
      notes: `إلغاء سند ${doc.transferNumber} — إعادة الكمية لرصيد الفرع المرسل`,
      createdBy: a.actor.userId,
    });
  }

  await tx
    .update(stockTransfers)
    .set({ status: "CANCELLED", cancelledBy: a.actor.userId, cancelledAt: new Date() })
    .where(eq(stockTransfers.id, a.transferId));
  return { transferId: a.transferId, transferNumber: doc.transferNumber };
}

export interface ListTransfersArgs {
  actor: TransferActor;
  /** admin/manager فقط: حصر بفرع معيّن (وإلا كل الفروع). غير المرفوعين يُجبَرون على فرعهم. */
  branchId?: number | null;
  direction?: "in" | "out" | "all";
  status?: "IN_TRANSIT" | "RECEIVED" | "CANCELLED" | "all";
  cursor?: number | null;
  limit?: number;
}

/** قائمة السندات بنطاق الفرع (وارد/صادر) + keyset pagination تنازلياً بالمعرّف. */
export async function listStockTransfers(a: ListTransfersArgs) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const limit = Math.min(a.limit ?? 30, 100);

  let scopeBranch: number | null;
  if (isElevated(a.actor)) {
    scopeBranch = a.branchId ?? null;
  } else {
    if (a.actor.branchId == null) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
    scopeBranch = Number(a.actor.branchId);
  }

  const conds = [] as any[];
  if (scopeBranch != null) {
    const dir = a.direction ?? "all";
    if (dir === "in") conds.push(eq(stockTransfers.toBranchId, scopeBranch));
    else if (dir === "out") conds.push(eq(stockTransfers.fromBranchId, scopeBranch));
    else conds.push(or(eq(stockTransfers.fromBranchId, scopeBranch), eq(stockTransfers.toBranchId, scopeBranch)));
  }
  if (a.status && a.status !== "all") conds.push(eq(stockTransfers.status, a.status));
  if (a.cursor) conds.push(lt(stockTransfers.id, a.cursor));

  const fromB = sql`(SELECT name FROM branches WHERE id = ${stockTransfers.fromBranchId})`;
  const rows = await db
    .select({
      id: stockTransfers.id,
      transferNumber: stockTransfers.transferNumber,
      fromBranchId: stockTransfers.fromBranchId,
      toBranchId: stockTransfers.toBranchId,
      status: stockTransfers.status,
      reason: stockTransfers.reason,
      totalSentBase: stockTransfers.totalSentBase,
      totalReceivedBase: stockTransfers.totalReceivedBase,
      createdAt: stockTransfers.createdAt,
      receivedAt: stockTransfers.receivedAt,
      fromBranchName: fromB.mapWith(String).as("fromBranchName"),
      toBranchName: sql`(SELECT name FROM branches WHERE id = ${stockTransfers.toBranchId})`.mapWith(String).as("toBranchName"),
      linesCount: sql`(SELECT COUNT(*) FROM stockTransferLines WHERE transferId = ${stockTransfers.id})`.mapWith(Number).as("linesCount"),
    })
    .from(stockTransfers)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(stockTransfers.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? Number(page[page.length - 1].id) : null };
}

/** تفاصيل سند بأسطره (أسماء المنتجات/الفروع/المستخدمين) — بنفس نطاق عزل القائمة. */
export async function getStockTransfer(transferId: number, actor: TransferActor) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  const doc = (await db.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).limit(1))[0];
  if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "سند التحويل غير موجود" });
  if (!isElevated(actor)) {
    const b = actor.branchId == null ? NaN : Number(actor.branchId);
    if (b !== Number(doc.fromBranchId) && b !== Number(doc.toBranchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "السند لا يخصّ فرعك" });
    }
  }

  const lines = await db
    .select({
      id: stockTransferLines.id,
      variantId: stockTransferLines.variantId,
      quantitySent: stockTransferLines.quantitySent,
      quantityReceived: stockTransferLines.quantityReceived,
      note: stockTransferLines.note,
      productName: products.name,
      variantName: productVariants.variantName,
      color: productVariants.color,
      sku: productVariants.sku,
    })
    .from(stockTransferLines)
    .innerJoin(productVariants, eq(productVariants.id, stockTransferLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(stockTransferLines.transferId, transferId))
    .orderBy(stockTransferLines.id);

  const userIds = [doc.createdBy, doc.receivedBy, doc.cancelledBy].filter((x): x is number => x != null);
  const branchRows = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(inArray(branches.id, [Number(doc.fromBranchId), Number(doc.toBranchId)]));
  const userRows = userIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
    : [];
  const bName = (id: number) => branchRows.find((b) => Number(b.id) === id)?.name ?? `فرع ${id}`;
  const uName = (id: number | null) => (id == null ? null : (userRows.find((u) => u.id === id)?.name ?? `مستخدم ${id}`));

  return {
    ...doc,
    fromBranchName: bName(Number(doc.fromBranchId)),
    toBranchName: bName(Number(doc.toBranchId)),
    createdByName: uName(doc.createdBy),
    receivedByName: uName(doc.receivedBy),
    cancelledByName: uName(doc.cancelledBy),
    lines,
  };
}

/** عدد السندات الواردة «بالطريق» — شارة «بانتظار الاستلام». null = كل الفروع (أدمن/مدير). */
export async function pendingIncomingCount(branchId: number | null): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const conds = [eq(stockTransfers.status, "IN_TRANSIT" as const)];
  if (branchId != null) conds.push(eq(stockTransfers.toBranchId, branchId));
  const rows = await db
    .select({ c: sql`COUNT(*)`.mapWith(Number) })
    .from(stockTransfers)
    .where(and(...conds));
  return rows[0]?.c ?? 0;
}
