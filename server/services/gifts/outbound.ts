// G-م٢: منح هدية صادرة للعميل. تحاكي expenseService.createStockExpenseTx: applyMovement(OUT, GIFT_OUT)
// + postEntry(GIFT_OUT: revenue=0, profit=-cost, amount=cost, **بلا invoiceId** ⇒ خارج وعاء العمولة تلقائياً).
// لا بيع، لا نقد للصندوق، لا ذمة على العميل. حوكمة SOD (منع الإساءة): فوق عتبة التكلفة أو من غير مدير ⇒
// PENDING_APPROVAL بلا أثر، يعتمدها **مدير آخر** (approveGift، SOD-04: المعتمِد ≠ المنشئ، admin مُستثنى).
import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { branches, customers, giftCampaigns, giftVoucherLines, giftVouchers, productVariants } from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement, convertToBaseQuantity, isBundleVariant, isServiceVariant } from "../inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
} from "../accounting/postingEngine";
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
  campaignId?: number | null; // ربط حملة (G-م٧) — ميزانيّتها (إن وُجدت) تُفرَض بقفل تسلسليّ
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
    if (!(ln.quantity > 0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر حفظ سطر الهدية",
          why: `كمية الهدية يجب أن تكون موجبة، والقيمة المُرسَلة ${ln.quantity}`,
          doThis: "أدخل كميّةً موجبة في «الكمية» ثمّ أعد الإرسال",
        }),
      });
    }
    if (await isBundleVariant(tx, ln.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر منح الهدية لمنتج بكج (مركّب)",
          why: "البكج بلا مخزونٍ ذاتيّ ولا كلفةٍ ذاتيّة، فمنحه هديّةً يعادل تفريغَ رصيد المكوّنات بلا أثرٍ يُحسَب",
          doThis: "افتح شاشة الهدية وامنح مكوّنات البكج مباشرةً بدلاً منه، فيُطبَّق الخصم على كل مكوّن بتكلفته",
        }),
      });
    }
    if (await isServiceVariant(tx, ln.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر منح الهدية لمنتج خدميّ",
          why: "المنتج الخدميّ بلا مخزونٍ يُخصَم منه ولا كلفةٍ يُقيَّد بها الهدية",
          doThis: "امنح صنفاً مخزنياً بدلاً منه، أو استعمل «قسيمة خصم» على فاتورة الخدمة",
        }),
      });
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

/**
 * المرحلة ١ لقفل الحملة: تُستدعى **قبل** أي قفل مخزون/متغيّرات — يطابق ترتيب approveGift (حملة ← مخزون ←
 * متغيّرات) فلا ينعكس الترتيب بين الإنشاء والاعتماد (تدقيق Codex P2 — ترتيبٌ معكوس يُنتج deadlock حين
 * يتزامن إنشاءُ هديةٍ مع اعتماد أخرى لنفس الحملة/الصنف). يرمي إن كانت الحملة غير موجودة أو مغلقة، ويعيد
 * budgetCost (أو null) لاستعماله لاحقاً في المرحلة ٢ بعد معرفة تكلفة الهدية.
 */
async function lockCampaignRow(tx: Tx, campaignId: number): Promise<string | null> {
  const camp = (
    await tx
      .select({ status: giftCampaigns.status, budgetCost: giftCampaigns.budgetCost })
      .from(giftCampaigns)
      .where(eq(giftCampaigns.id, campaignId))
      .for("update")
      .limit(1)
  )[0];
  if (!camp) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر ربط الهدية بالحملة",
        why: `الحملة رقم ${campaignId} غير موجودة أو أُزيلت`,
        doThis: "افتح شاشة «حملات الهدايا» واختر حملةً نشطة، أو أنشئ حملةً جديدة",
      }),
    });
  }
  if (camp.status !== "ACTIVE") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر ربط الهدية بالحملة",
        why: `الحملة مغلقة (حالتها ${camp.status})، ولا تُربَط بها هدايا جديدة`,
        doThis: "اختر حملةً نشطة من «حملات الهدايا»، أو اطلب من المدير إعادة فتح الحملة أو إنشاء حملة جديدة",
      }),
    });
  }
  return camp.budgetCost;
}

/**
 * المرحلة ٢: تتحقّق من الميزانيّة بعد حساب تكلفة الهدية (القفل من المرحلة ١ لا يزال سارياً لنفس المعاملة).
 * ⚠️ قراءة المُنفَق **يجب** أن تكون FOR UPDATE (قراءة حيّة) لا SELECT عاديّاً (تدقيق Codex P1): تحت
 * REPEATABLE READ الافتراضي في MySQL، قراءةٌ عاديّة تُرجع لقطة المعاملة المُثبَّتة عند أوّل قراءةٍ فيها
 * (قبل انتظار قفل الحملة أعلاه) — فلا ترى هديةً منافِسةً على نفس الحملة التزمت (commit) بعد أخذ اللقطة
 * وقبل حصولنا على القفل، فيتّفق مديران على «متبقٍّ كافٍ» يتجاوز مجموعهما الميزانيّة فعلياً. FOR UPDATE
 * يفرض قراءةً حيّةً (current read) تتجاوز اللقطة القديمة، مطابقةً لأحدث التزامٍ فعليّ.
 */
async function checkCampaignBudget(tx: Tx, campaignId: number, budgetCost: string | null, additionalCost: Decimal): Promise<boolean> {
  if (budgetCost == null) return false;
  const spentRow = await tx
    .select({ spent: giftVouchers.totalCost })
    .from(giftVouchers)
    .where(and(eq(giftVouchers.campaignId, campaignId), eq(giftVouchers.status, "DELIVERED")))
    .for("update");
  const spent = spentRow.reduce((acc, r) => acc.plus(money(r.spent ?? "0")), money(0));
  return spent.plus(additionalCost).gt(money(budgetCost));
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
    postingIntent: createPostingIntent(
      "GIFT_OUT_PROMO",
      "GIFT_OUT",
      signedPostingLines("GIFTS_PROMO", "INVENTORY", total),
    ),
    dedupeKey: `GIFT:${giftVoucherId}`,
    notes: "هدية صادرة للعميل",
  });
}

export async function createOutboundGift(input: CreateOutboundGiftInput, actor: Actor): Promise<OutboundGiftResult> {
  if (!input.lines?.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ سند الهدية",
        why: "سند الهدية بلا أسطر، ولا يُقبل سندٌ فارغ",
        doThis: "أضف صنفاً واحداً على الأقل مع كميّته من زرّ «إضافة صنف»، ثمّ أعد الحفظ",
      }),
    });
  }

  return withTx(async (tx) => {
    const b = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!b) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر حفظ سند الهدية",
          why: `الفرع رقم ${input.branchId} غير موجود أو أُزيل`,
          doThis: "اختر فرعاً موجوداً من قائمة الفروع، أو راجع مدير النظام (admin) لإنشاء الفرع",
        }),
      });
    }
    if (input.customerId != null) {
      const c = (await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
      if (!c) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر حفظ سند الهدية",
            why: `العميل رقم ${input.customerId} غير موجود أو أُزيل`,
            doThis: "اختر عميلاً من القائمة، أو أنشئ العميل أوّلاً من «العملاء»، أو احفظ الهدية بلا عميلٍ محدَّد",
          }),
        });
      }
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

    // ربط حملة (G-م٧) — المرحلة ١: قفل صفّ الحملة **قبل** قفل المخزون/المتغيّرات أدناه (يطابق ترتيب
    // approveGift: حملة ← مخزون ← متغيّرات — تدقيق Codex P2، ترتيبٌ معكوس بين المسارين يُنتج deadlock).
    // يرمي فوراً إن كانت الحملة مغلقة/غير موجودة، ويحفظ الميزانيّة لفحصها في المرحلة ٢ بعد حساب التكلفة.
    const campaignBudget = input.campaignId != null ? await lockCampaignRow(tx, input.campaignId) : null;

    // mutex المتغيّرات ثم branchStock (الترتيب الحاكم مع الوارد/الشراء).
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

    // ربط حملة — المرحلة ٢: فحص الميزانيّة الآن بعد معرفة التكلفة (القفل من المرحلة ١ لا يزال سارياً).
    const overCampaignBudget = input.campaignId != null ? await checkCampaignBudget(tx, input.campaignId, campaignBudget, totalCost) : false;

    // حوكمة SOD: admin يُنجز مباشرةً؛ المدير يُنجز تحت العتبة (العامة وميزانيّة الحملة) فقط؛ غيرهما يلزمه اعتماد دائماً.
    const isAdmin = actor.role === "admin";
    const isManager = actor.role === "manager";
    const overThreshold = totalCost.gt(money(GIFT_APPROVAL_THRESHOLD));
    const needsApproval = !isAdmin && (overThreshold || !isManager || overCampaignBudget);

    const giftNumber = await nextGiftNumber(tx, input.branchId);
    const insHead = await tx.insert(giftVouchers).values({
      giftNumber,
      direction: "OUT",
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      campaignId: input.campaignId ?? null,
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
  if (!isAdmin && !isManager) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر اعتماد الهدية",
        why: "اعتماد الهدايا الصادرة من صلاحية المدير أو المالك فقط، وحسابك لا يحمل أياً منهما",
        doThis: "اطلب من المدير أو المالك اعتماد الطلب من شاشة «الهدايا الصادرة»",
      }),
    });
  }

  return withTx(async (tx) => {
    const gift = (await tx.select().from(giftVouchers).where(eq(giftVouchers.id, giftId)).for("update").limit(1))[0];
    if (!gift) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد الهدية",
          why: `سند الهدية رقم ${giftId} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «الهدايا الصادرة» واختر سنداً من القائمة الحاليّة",
        }),
      });
    }
    if (gift.direction !== "OUT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد الهدية",
          why: `هذا المسار للهدايا الصادرة فقط، والسند اتّجاهه ${gift.direction}`,
          doThis: "افتح السند من شاشته الأصليّة، أو اختر هديّةً صادرة من قائمة الاعتماد",
        }),
      });
    }
    if (gift.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد الهدية",
          why: `لا يُعتمَد إلّا طلبٌ في انتظار الموافقة — حالة هذا السند ${gift.status}`,
          doThis: "حدّث شاشة «الهدايا الصادرة» لترى الحالة الحاليّة",
        }),
      });
    }
    // عزل الفرع: غير الأدمن يعتمد فرعه فقط.
    if (!isAdmin && Number(gift.branchId) !== actor.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر اعتماد الهدية",
          why: `السند مسجَّل على فرعٍ آخر (فرع ${gift.branchId}) لا فرعك (${actor.branchId}), ومدير الفرع محظور من العبور بين الفروع`,
          doThis: "اعتمد السند من فرعه الأصليّ، أو اطلب من المالك/الأدمن اعتماده",
        }),
      });
    }
    // SOD-04: المُنشئ لا يعتمد هديته (admin مُستثنى للتصحيح الإداري).
    if (!isAdmin && Number(gift.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر اعتماد الهدية",
          why: "أنت من فتح هذا السند، وفصل المهام (SOD-04) يمنعك من اعتماد هديّةٍ أنشأتها بنفسك",
          doThis: "اطلب من مديرٍ آخر أو من المالك اعتماد الطلب من نفس الشاشة",
        }),
      });
    }
    // الحملة قد تُغلَق بين الإنشاء والاعتماد — غير الأدمن لا يعتمد هديةً لحملةٍ أُغلقت (admin يصحّح إدارياً).
    if (gift.campaignId != null && !isAdmin) {
      const camp = (await tx.select({ status: giftCampaigns.status }).from(giftCampaigns).where(eq(giftCampaigns.id, Number(gift.campaignId))).for("update").limit(1))[0];
      if (camp && camp.status !== "ACTIVE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر اعتماد الهدية",
            why: `الحملة المرتبطة بهذا السند أُغلقت (حالتها ${camp.status}) بين الإنشاء والاعتماد`,
            doThis: "اطلب من المالك/الأدمن اعتماد السند إدارياً، أو ألغِ السند وأنشئ هديّةً بحملةٍ نشطة",
          }),
        });
      }
    }

    const lineRows = await tx.select().from(giftVoucherLines).where(eq(giftVoucherLines.giftVoucherId, giftId));
    if (!lineRows.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد الهدية",
          why: `سند الهدية رقم ${giftId} بلا أسطر (حُذفت أو لم تُحفَظ)`,
          doThis: "ألغِ السند وأنشئ هديّةً جديدة بأسطرها الصحيحة",
        }),
      });
    }
    const variantIds = Array.from(new Set(lineRows.map((l) => Number(l.variantId)))).sort((a, b) => a - b);
    // mutex المتغيّرات ثم branchStock (الترتيب الحاكم).
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

export interface CancelGiftResult {
  giftVoucherId: number;
  status: "CANCELLED";
}

/**
 * المسار و-١ (١٧/٨): إلغاء طلب هديةٍ صادرةٍ معلَّق — **المخرج الذي لم يكن موجوداً**.
 *
 * كانت الهدية المعلَّقة تملك مساراً واحداً: الاعتماد. فمن يكتشف خطأً في طلبه (صنفٌ غلط، كمية،
 * زبونٌ آخر) أمام خيارين كلاهما سيّئ: أن يُعتمَد إنفاقٌ لا يريده، أو أن يبقى الطلب في الطابور
 * أبداً يشوّش على المعتمِدين. الإلغاء هنا **صفر أثرٍ ماليّ** بحكم البناء: الأثر (حركة المخزون
 * وقيد التكلفة) لا يُطبَّق إلّا في `approveGift` عبر `applyOutboundEffect` — فالمعلَّق لم يمسّ
 * شيئاً بعد، والإلغاء تغييرُ حالةٍ محض.
 *
 * ومَن يُلغي: **صاحب الطلب** (سحبُ طلبك حقُّك) أو مديرٌ في فرع الهدية أو أدمن. لا يلزم فصل مهام
 * هنا لأنّ الإلغاء لا يُنشئ إنفاقاً — بخلاف الاعتماد الذي يحرسه SOD-04.
 */
export async function cancelOutboundGift(
  giftId: number,
  actor: Actor,
  reason?: string,
): Promise<CancelGiftResult> {
  const isAdmin = actor.role === "admin";
  const isManager = actor.role === "manager";
  return withTx(async (tx) => {
    const gift = (await tx.select().from(giftVouchers).where(eq(giftVouchers.id, giftId)).for("update").limit(1))[0];
    if (!gift) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب الهدية",
          why: `سند الهدية رقم ${giftId} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «الهدايا الصادرة» واختر سنداً من القائمة الحاليّة",
        }),
      });
    }
    if (gift.direction !== "OUT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب الهدية",
          why: `هذا المسار للهدايا الصادرة فقط، والسند اتّجاهه ${gift.direction}`,
          doThis: "افتح السند من شاشته الأصليّة، أو اختر هديّةً صادرة من قائمة الإلغاء",
        }),
      });
    }
    if (gift.status !== "PENDING_APPROVAL") {
      // المُنجَزة تُعالَج بعكسٍ محاسبيّ لا بإلغاء حالة (الأثر مُرحَّل فعلاً).
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب الهدية",
          why: `لا يُلغى إلّا طلبٌ معلَّق (PENDING_APPROVAL) — حالة هذه الهدية ${gift.status}`,
          doThis: "للهدية المُنجَزة (DELIVERED) استعمل «عكس/مرتجع الهدية» بدل الإلغاء، وللمُلغاة أو المرفوضة سلفاً لا حاجة لإجراءٍ آخر",
        }),
      });
    }
    const isOwnerOfRequest = Number(gift.createdBy) === actor.userId;
    if (!isAdmin && !isOwnerOfRequest && !isManager) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب الهدية",
          why: "الإلغاء لصاحب الطلب أو لمديرٍ في فرع الهدية أو للأدمن، وحسابك ليس منهم",
          doThis: "اطلب من صاحب الطلب سحبَه، أو من المدير/الأدمن إلغاءه من شاشة «الهدايا الصادرة»",
        }),
      });
    }
    if (!isAdmin && Number(gift.branchId) !== actor.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب الهدية",
          why: `السند مسجَّل على فرعٍ آخر (فرع ${gift.branchId}) لا فرعك (${actor.branchId})، ومدير الفرع محظور من العبور بين الفروع`,
          doThis: "افتح السند من فرعه الأصليّ، أو اطلب من المالك/الأدمن إلغاءه",
        }),
      });
    }
    const note = reason?.trim();
    await tx
      .update(giftVouchers)
      .set({
        status: "CANCELLED",
        notes: note ? `${gift.notes ? `${gift.notes}\n` : ""}أُلغي الطلب: ${note}` : gift.notes,
      })
      .where(eq(giftVouchers.id, giftId));
    return { giftVoucherId: giftId, status: "CANCELLED" };
  });
}
