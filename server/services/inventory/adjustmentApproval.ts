// اعتماد تسويات المخزون المُعلَّقة (فصل مهام #٦، الشريحة ٢).
//
// التسوية المباشرة للمخزون (`inventory.adjust`) عمليةٌ حسّاسة (قد تُخفي عجزاً/سرقة) ⇒ قرار المالك ١٨/٧:
// اعتماد ثنائيّ بلا عتبة. لا آلية اعتماد للمخزون (بخلاف السندات النقدية) ⇒ آلية جديدة: يُنشئ الطلبُ صفّاً
// معلَّقاً في `stockAdjustmentRequests` **بلا تغيير مخزون**، ويعتمده مديرٌ آخر (SOD-04: المُعتمِد ≠ المُنشئ
// إلا admin) فيُطبَّق `setStock` + قيد ADJUST (نفس منطق المسار المباشر السابق). الرفض بلا أثر.
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { autoDecideForActiveOwner } from "../approval/ownerAutoDecision";
import { stockAdjustmentApprovalTrigger } from "@shared/approvalTriggers";
import { appErrorMessage } from "@shared/errors";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  branchStock,
  openingModeSettings,
  products,
  productVariants,
  stockAdjustmentRequests,
  users,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { setStock, isBundleVariant, isServiceVariant } from "../inventoryService";
import { lockInventoryVariants } from "./stockLock";
import { loadOpeningPurchaseLinkedVariantIds } from "../stocktake/openingEligibility";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { money } from "../money";
import { requireDb } from "../tx";
import { type Actor, withTx } from "../tx";

const ADJUSTMENT_REQUEST_OPERATION = "inventory.adjustRequest";

/**
 * أسبابُ تسوية المخزون (P2-#3، ٢٥/٨) — مصدرُ الحقيقة الوحيد. الأسبابُ الحسّاسة أدناه تُلزم مرفقَ
 * إثبات (صورة). قرارُ المالك: التالف/الفقد/السرقة قصصٌ ماليّة قابلةٌ للتحقيق، وبلا دليلٍ بصريّ
 * تُوقّع الشركة على النصّ وحده — فهذه الأسباب تُغلق دون مرفق.
 */
export const ADJUSTMENT_REASONS = [
  "STOCK_TAKE",
  "DAMAGE",
  "LOSS",
  "THEFT",
  "SAMPLE",
  "INTERNAL_USE",
  "GIFT",
  "CORRECTION",
  "OTHER",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** الأسبابُ التي تُلزم مرفقاً بصرياً (صورة) — للتحقيق المستقلّ. */
export const ATTACHMENT_REQUIRED_REASONS: ReadonlySet<AdjustmentReason> = new Set<AdjustmentReason>([
  "DAMAGE",
  "LOSS",
  "THEFT",
]);

/** حجم data URL الأقصى المقبول (~5MB بعد base64 encoding — يحمي المخطّط من الضخامة العشوائية). */
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024; // ~5MB binary → ~7MB base64

function validateAttachmentUrl(url: string): void {
  const trimmed = url.trim();
  // نمطُ data URL لصورة: `data:image/<type>;base64,<payload>`. غيرُه مرفوض (لا URL خارجيّ يُستضاف
  // ثمّ يختفي، ولا نوع ملفٍ غير مدعوم في العرض داخل الشاشة).
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ مرفق الإثبات — الصيغة غير مقبولة (JPEG/PNG/WebP/GIF بصيغة data URL)",
        why: "الشاشة ترسل الصور مضمَّنة data URL لا روابطَ خارجية، والمُرسَل ليس صورةً مدعومة بهذه الصيغة",
        doThis: "اختر صورةً بامتداد JPG/PNG/WebP/GIF من زرّ المرفق، وتجنّب لصق روابطَ خارجية",
      }),
    });
  }
  if (trimmed.length > MAX_ATTACHMENT_BYTES) {
    const maxMb = Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024));
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ مرفق الإثبات",
        why: `حجم المرفق (${trimmed.length} حرفاً بعد الترميز) يتجاوز السقف ${maxMb}MB`,
        doThis: "اضغط الصورة أو أعد التقاطها بدقّةٍ أقلّ، ثمّ أعد الإرسال",
      }),
    });
  }
}

const COST_SNAPSHOT_RE = /^\[COST_SNAPSHOT:([0-9]+(?:\.[0-9]{1,2})?)\](?:\n|$)/;

function encodeAdjustmentNotes(cost: string, notes?: string | null): string {
  const human = notes?.trim();
  return `[COST_SNAPSHOT:${money(cost).toFixed(2)}]${human ? `\n${human}` : ""}`;
}

function decodeAdjustmentNotes(notes?: string | null): { cost: string | null; human: string | null } {
  const raw = notes ?? "";
  const match = raw.match(COST_SNAPSHOT_RE);
  if (!match) return { cost: null, human: raw.trim() || null };
  return {
    cost: money(match[1]).toFixed(2),
    human: raw.slice(match[0].length).trim() || null,
  };
}

export interface RequestAdjustmentInput {
  variantId: number;
  branchId: number;
  targetQuantity: number;
  notes?: string | null;
  /**
   * سببُ التسوية. اختياريٌّ للتوافق مع مستدعياتٍ قديمة، لكنّ الشاشات الجديدة تُلزمه.
   * الأسبابُ الحسّاسة (DAMAGE/LOSS/THEFT) تُلزم `attachmentUrl` — P2-#3.
   */
  reason?: AdjustmentReason | null;
  /** مرفقُ إثبات بصريّ (data URL لصورةٍ مضغوطة). إلزاميّ للأسباب الحسّاسة أعلاه. */
  attachmentUrl?: string | null;
  /**
   * مفتاح تكرار من العميل. إعادةُ الإرسال بنفس المفتاح والحمولة تُرجع الطلب الأوّل بدل إنشاء
   * ثانٍ (اقتراح تقرير المراجعة P2-#1، ٢٥/٨). الحمولةُ المختلفة على نفس المفتاح تُرفَض CONFLICT.
   */
  clientRequestId?: string | null;
}

function assertRequesterBranch(branchId: number, actor: Actor): void {
  if (actor.role === "admin") return;
  if (actor.branchId == null || Number(actor.branchId) !== Number(branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر فتح طلب تسوية المخزون",
        why: `الطلب موجَّه لفرعٍ آخر (${branchId}) لا فرعك (${actor.branchId ?? "غير محدَّد"})، ومدير الفرع محظور من العبور بين الفروع`,
        doThis: "افتح الطلب من فرعه الأصليّ، أو اطلب من المالك/الأدمن معالجته",
      }),
    });
  }
}

/** يُنشئ طلب تسوية مخزونٍ معلَّقاً — **بلا تغيير مخزون** حتى الاعتماد. */
export async function requestStockAdjustment(
  input: RequestAdjustmentInput,
  actor: Actor,
): Promise<{ requestId: number; status: "PENDING_APPROVAL" | "APPROVED"; idempotentReplay?: true }> {
  // حارس خدمة لا يعتمد على الراوتر: لا يجوز للمستدعي تزوير actor.branchId=target.
  assertRequesterBranch(input.branchId, actor);
  // P2-#3: التحقّق من السبب/المرفق قبل أيّ عملٍ في القاعدة (لا صفٌّ نصف صالحٍ يُتَراجَع عنه).
  const reason = input.reason ?? null;
  const attachmentUrl = input.attachmentUrl?.trim() || null;
  if (reason != null && !ADJUSTMENT_REASONS.includes(reason)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب تسوية المخزون",
        why: `سبب التسوية «${reason}» غير مسجَّل في قائمة الأسباب المعتمَدة`,
        doThis: `اختر سبباً من القائمة الرسميّة: ${ADJUSTMENT_REASONS.join("، ")}`,
      }),
    });
  }
  if (attachmentUrl) validateAttachmentUrl(attachmentUrl);
  if (reason != null && ATTACHMENT_REQUIRED_REASONS.has(reason) && !attachmentUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب تسوية المخزون",
        why: `السبب «${reason}» من الأسباب الحسّاسة (تالف/فقد/سرقة) ويستلزم مرفقَ إثبات بصريّ`,
        doThis: "التقط صورةً واضحة للصنف/الحدث وألصقها من زرّ المرفق، ثمّ أعد الإرسال",
      }),
    });
  }
  // ⭐ Idempotency على مستوى الطلب (P2-#1): إعادةُ الشاشة إرسالَ نفس العملية (نقر مضاعف، انقطاعُ شبكة)
  // كانت تُنشئ طلبَين معلَّقَين متطابقَين. اعتمادُهما لاحقاً بالخطأ = **مضاعفةُ تسوية**. الحلّ: نفس مفتاح
  // العميل + نفس الحمولة ⇒ إعادةُ الطلب الأوّل بلا إنشاء. نفس المفتاح بحمولةٍ مختلفة ⇒ CONFLICT (بصمة).
  // السبب/المرفق جزءان من البصمة كي لا يُبتلع تغييرٌ فيهما صامتاً كـreplay.
  const clientRequestId = input.clientRequestId?.trim() || null;
  const payloadHash = clientRequestId
    ? idempotencyHash({
        variantId: Number(input.variantId),
        branchId: Number(input.branchId),
        targetQuantity: Number(input.targetQuantity),
        notes: input.notes?.trim() || null,
        reason,
        attachmentUrl,
      })
    : null;
  const result = await withTx(async (tx) => {
    if (!Number.isInteger(input.targetQuantity) || input.targetQuantity < 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب تسوية المخزون",
          why: `الرصيد المستهدف يجب أن يكون صحيحاً غير سالب، والمُرسَل ${input.targetQuantity}`,
          doThis: "أدخل رصيداً مستهدفاً صحيحاً (بلا كسور) وموجباً أو صفراً في «الكمية المستهدفة»، ثمّ أعد الإرسال",
        }),
      });
    }
    if (clientRequestId) {
      const existing = await checkIdempotency(tx, ADJUSTMENT_REQUEST_OPERATION, clientRequestId, payloadHash);
      if (existing != null) {
        return { requestId: existing, status: "PENDING_APPROVAL" as const, idempotentReplay: true as const };
      }
    }
    const v = (
      await tx
        .select({
          id: productVariants.id,
          costPrice: productVariants.costPrice,
          isConsignment: products.isConsignment,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productVariants.id, input.variantId))
        .limit(1)
    )[0];
    if (!v) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح طلب تسوية المخزون",
          why: `المتغيّر رقم ${input.variantId} غير موجود أو أُزيل`,
          doThis: "اختر صنفاً/متغيّراً موجوداً من قائمة المنتجات، أو أنشئ المنتج أوّلاً",
        }),
      });
    }
    if (v.isConsignment) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب تسوية المخزون",
          why: "الصنف بضاعة أمانة، وبضاعة الأمانة لا تُسوّى بطلب تعديل مخزون",
          doThis: "استعمل «سندات الأمانة» (وارد/صادر) أو «الجرد الدوري» للأمانة من شاشة «الأمانة»",
        }),
      });
    }
    // C2 (مراجعة عدائية): مرآة حراس setStock عند الطلب — لا نُنشئ طلباً يستحيل اعتماده (البكج يُرفَض عند
    // الاعتماد فيبقى معلَّقاً للأبد؛ الخِدميّ لا مخزون له). البكج يُسوَّى بمكوّناته لا مباشرةً.
    if (await isBundleVariant(tx, input.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب تسوية المخزون",
          why: "الصنف بكج (مركّب) لا مخزون ذاتيّ له، فتسويةُ مخزونه مباشرةً بلا معنى",
          doThis: "سوِّ مخزون مكوّنات البكج فرداً فرداً من شاشة «الجرد/التسوية»، وطاقةُ البكج تُشتقّ منها تلقائياً",
        }),
      });
    }
    if (await isServiceVariant(tx, input.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب تسوية المخزون",
          why: "الصنف خدميّ (بلا مخزون)، فتسويةُ كمّيته بلا معنى",
          doThis: "استعمل هذه التسوية للأصناف المخزنية فقط، وللأصناف الخدميّة عدّل السعر أو الوصف من «تعديل المنتج»",
        }),
      });
    }
    // C1 (مراجعة عدائية): لقطة الرصيد الحاليّ لحظة الطلب — يُكشَف بها الانحراف عند الاعتماد.
    const cur = (
      await tx.select({ q: branchStock.quantity }).from(branchStock)
        .where(and(eq(branchStock.variantId, input.variantId), eq(branchStock.branchId, input.branchId))).limit(1)
    )[0];
    const res = await tx.insert(stockAdjustmentRequests).values({
      variantId: input.variantId,
      branchId: input.branchId,
      targetQuantity: input.targetQuantity,
      expectedQuantity: Number(cur?.q ?? 0),
      // لقطة تكلفة داخل الحقل الموجود (لا تغيير schema): الاعتماد يرفض إن تغيّرت WAVG منذ الطلب،
      // كي لا تتبدّل قيمة الربح/الخسارة بينما كمية الفرع بقيت كما هي.
      notes: encodeAdjustmentNotes(v.costPrice ?? "0", input.notes),
      reason,
      attachmentUrl,
      status: "PENDING_APPROVAL",
      createdBy: actor.userId,
    });
    const requestId = extractInsertId(res);
    if (clientRequestId) {
      // نسجّل المفتاح **بعد** نجاح الإدراج ⇒ فشلٌ داخل المعاملة يعمل ROLLBACK فيُلغى المفتاح مع الطلب،
      // وسباقُ طلبَين بنفس المفتاح يتلقّى ER_DUP_ENTRY على القيد الفريد فيراه المستدعي.
      await recordIdempotencyKey(tx, ADJUSTMENT_REQUEST_OPERATION, clientRequestId, requestId, payloadHash);
    }
    return { requestId, status: "PENDING_APPROVAL" as const };
  });
  if (result.idempotentReplay) return result;
  const approved = await autoDecideForActiveOwner(actor, {
    kind: "inventory.adjustment.approve",
    id: result.requestId,
    reason: input.notes ?? input.reason ?? null,
  });
  return approved ? { ...result, status: "APPROVED" as const } : result;
}

/** يفرض SOD-04 (المُعتمِد ≠ المُنشئ إلا admin) + عزل الفرع (غير admin يعتمد فرعه فقط). */
function assertIndependentInventoryReviewer(r: { createdBy: number | null; branchId: number }, actor: Actor, verb: string): void {
  if (actor.role !== "admin" && r.createdBy != null && Number(r.createdBy) === actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر ${verb} تسوية المخزون`,
        why: `أنت من طلبتها بنفسك، وفصل المهام (SOD-04) يمنعك من ${verb} تسويةٍ فتحتها بنفسك`,
        doThis: `اطلب من مديرٍ آخر أو من المالك ${verb} التسوية من شاشة «طلبات تسوية المخزون»`,
      }),
    });
  }
  if (actor.role !== "admin" && actor.branchId != null && Number(r.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر ${verb} تسوية المخزون`,
        why: `التسوية مسجَّلة على فرعٍ آخر (${r.branchId}) لا فرعك (${actor.branchId})، ومدير الفرع محظور من العبور بين الفروع`,
        doThis: `افتح التسوية من فرعها الأصليّ، أو اطلب من المالك/الأدمن ${verb}ها`,
      }),
    });
  }
}

/** يعتمد طلب تسوية معلَّق: SOD-04 ⇒ يطبّق `setStock` + قيد ADJUST بقيمة الفرق × التكلفة. */
export async function approveStockAdjustment(
  id: number,
  actor: Actor,
): Promise<{ movementId: number; newQuantity: number; delta: number }> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(stockAdjustmentRequests).where(eq(stockAdjustmentRequests.id, id)).for("update").limit(1)
    )[0];
    if (!r) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد تسوية المخزون",
          why: `طلب التسوية رقم ${id} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «طلبات تسوية المخزون» واختر طلباً قائماً من القائمة الحاليّة",
        }),
      });
    }
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد تسوية المخزون",
          why: `الطلب ليس في انتظار الموافقة — حالته الحاليّة ${r.status}`,
          doThis: "حدّث شاشة «طلبات تسوية المخزون» لترى الحالة الحاليّة، وإن لزمت تسويةٌ أخرى افتح طلباً جديداً",
        }),
      });
    }
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: stockAdjustmentApprovalTrigger("APPROVE"),
      subject: `تسوية مخزون رقم ${id}`,
      legacy: () =>
        assertIndependentInventoryReviewer(
          { createdBy: r.createdBy != null ? Number(r.createdBy) : null, branchId: Number(r.branchId) },
          actor,
          "اعتماد",
        ),
    });

    const branchId = Number(r.branchId);
    await lockInventoryVariants(tx, [Number(r.variantId)]);
    // C1 (مراجعة عدائية): تفاؤليّ — الهدف مطلق، فلو تغيّر الرصيد بين الطلب والاعتماد (بيع/شراء/تحويل)
    // لكان الاعتماد يمحو تلك الحركات ويُرحّل ربحاً/خسارةً وهميّة. نرفض إن انحرف الرصيد الحيّ عن لقطة الطلب.
    const cur = (
      await tx.select({ q: branchStock.quantity, openedAt: branchStock.openedAt }).from(branchStock)
        .where(and(eq(branchStock.variantId, Number(r.variantId)), eq(branchStock.branchId, branchId))).for("update").limit(1)
    )[0];
    const liveQty = Number(cur?.q ?? 0);
    if (liveQty !== Number(r.expectedQuantity)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد تسوية المخزون",
          why: `تغيّر المخزون منذ الطلب (كان ${r.expectedQuantity}، الآن ${liveQty})؛ اعتماده يمحو حركاتٍ بينهما ويُرحّل ربحاً/خسارةً وهميّة`,
          doThis: "ارفض الطلب وافتح طلباً جديداً بالرصيد الحاليّ من شاشة «طلبات تسوية المخزون»",
        }),
      });
    }
    // ترتيب القفل الحاكم مع الشراء/WAVG: productVariants ثم branchStock. نحجز لقطة التكلفة حتى
    // نهاية الاعتماد، ونرفض أيضاً أي طلب قديم صار صنفه أمانة قبل تطبيق حركة أو قيد.
    const variant = (
      await tx
        .select({
          costPrice: productVariants.costPrice,
          isConsignment: products.isConsignment,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productVariants.id, Number(r.variantId)))
        .for("update")
        .limit(1)
    )[0];
    if (!variant) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد تسوية المخزون",
          why: `المتغيّر رقم ${r.variantId} غير موجود أو أُزيل بعد إنشاء الطلب`,
          doThis: "ارفض الطلب مع سببٍ صريح، ثم افتح طلباً جديداً على صنفٍ قائم",
        }),
      });
    }
    if (variant.isConsignment) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر اعتماد تسوية المخزون",
          why: "الصنف صار بضاعة أمانة بعد إنشاء الطلب، وبضاعة الأمانة لا تُعتمَد كتسوية مخزون",
          doThis: "ارفض الطلب واستعمل «سندات الأمانة» (وارد/صادر) أو «الجرد الدوري» للأمانة من شاشة «الأمانة»",
        }),
      });
    }
    // تدقيق ١١/٨ (H3): أثناء نافذة الافتتاح، تسوية صنفٍ **غير مُفتتَح** = تثبيت رصيدٍ افتتاحيّ ⇒ مسار
    // OPENING (يختم openedAt مركزياً) **بصفر أثر P&L** بدل ترحيل ADJUST بقيمة الفرق × التكلفة (كان يُنتج
    // ربحاً/خسارةً وهميّاً). لكن openedAt IS NULL وحده لا يكفي (مراجعة Codex): الصنف المرتبط بأمر شراءٍ غير
    // ملغى (له مصدرٌ شرائيّ سيُستلَم) — تأسيسه OPENING يزدوج مع مصدره لاحقاً، فنستثنيه (نفس أهلية
    // الجرد الافتتاحي في create/liveScope). الأمانة مرفوضة أعلاه من مسار التسوية كله.
    const om = (await tx.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1))[0];
    const windowActive = !!om?.enabled && om.endsAt != null && om.endsAt.getTime() > Date.now();
    let openingEstablish = windowActive && cur?.openedAt == null;
    if (openingEstablish) {
      const purchaseLinked = await loadOpeningPurchaseLinkedVariantIds(tx, branchId, [Number(r.variantId)]);
      if (purchaseLinked.has(Number(r.variantId))) openingEstablish = false;
    }
    // يطبّق المخزون الآن (لحظة الاعتماد) — setStock يفرض حراس الخدمة/البكج. قد يرمي ⇒ يُلغى الاعتماد كلّه.
    // مرجع OPENING عند التثبيت الافتتاحيّ ⇒ ختم openedAt (بلا referenceId: تدفّق حقيقي في netAfter لاحقاً).
    const stockRes = await setStock(tx, {
      variantId: Number(r.variantId),
      branchId,
      targetQuantity: r.targetQuantity,
      referenceType: openingEstablish ? "OPENING" : undefined,
      notes: openingEstablish ? "تسوية رصيد افتتاحيّ معتمَدة" : undefined,
      createdBy: actor.userId,
    });
    // قيد ADJUST بقيمة الفرق × التكلفة — يُتجاوَز كلياً في التثبيت الافتتاحيّ (صفر أثر P&L، كالجرد الافتتاحي).
    if (!openingEstablish && stockRes.delta && stockRes.delta !== 0) {
      const noteData = decodeAdjustmentNotes(r.notes);
      if (noteData.cost == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر اعتماد تسوية المخزون",
            why: "طلب التسوية قديم ولا يحمل لقطةً موثَّقة لتكلفة الصنف وقت الطلب، فلا يمكن التحقّق من ثبات التكلفة",
            doThis: "ارفض الطلب مع سببٍ صريح، ثم افتح طلباً جديداً من شاشة «طلبات تسوية المخزون» (تُحفَظ فيه لقطة التكلفة تلقائياً)",
          }),
        });
      }
      const liveCost = money(variant.costPrice ?? "0").toFixed(2);
      if (liveCost !== noteData.cost) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد تسوية المخزون",
            why: `تغيّرت تكلفة الصنف منذ الطلب (كانت ${noteData.cost}، الآن ${liveCost})؛ اعتماده يُرحّل ربحاً/خسارةً بقيمةٍ لم تكن قائمةً وقت الطلب`,
            doThis: "ارفض الطلب وافتح طلباً جديداً بالتكلفة الحاليّة من شاشة «طلبات تسوية المخزون»",
          }),
        });
      }
      const adjustValue = money(noteData.cost).times(stockRes.delta);
      if (!adjustValue.isZero()) {
        const postingSourceComponents = adjustValue.isPositive()
          ? {
              roleDebits: { INVENTORY: adjustValue },
              roleCredits: { OTHER_REVENUE: adjustValue },
            }
          : {
              roleDebits: { LOSSES: adjustValue.abs() },
              roleCredits: { INVENTORY: adjustValue.abs() },
            };
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId,
          cost: adjustValue.neg(),
          profit: adjustValue,
          amount: money(0),
          dedupeKey: `INV_ADJUST:${stockRes.movementId}`,
          notes: `تسوية مخزون معتمَدة (طلب #${id})${noteData.human ? ` — ${noteData.human}` : ""}`,
          postingIntent: adjustValue.isPositive()
            ? createPostingIntent(
              "ADJUST_INVENTORY_GAIN",
              "ADJUST",
              [debitLine("INVENTORY", adjustValue), creditLine("OTHER_REVENUE", adjustValue)],
              {
                roleDebits: { INVENTORY: adjustValue },
                roleCredits: { OTHER_REVENUE: adjustValue },
              },
            )
            : createPostingIntent(
              "ADJUST_INVENTORY_LOSS",
              "ADJUST",
              [debitLine("LOSSES", adjustValue.abs()), creditLine("INVENTORY", adjustValue.abs())],
              {
                roleDebits: { LOSSES: adjustValue.abs() },
                roleCredits: { INVENTORY: adjustValue.abs() },
              },
            ),
          postingSourceComponents,
        });
      }
    }
    await tx.update(stockAdjustmentRequests).set({
      status: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      appliedMovementId: stockRes.movementId,
    }).where(eq(stockAdjustmentRequests.id, id));
    return { movementId: stockRes.movementId, newQuantity: stockRes.newQuantity, delta: stockRes.delta ?? 0 };
  });
}

/** يرفض طلب تسوية معلَّق — بلا أثر مخزون. نفس قاعدة SOD-04. */
export async function rejectStockAdjustment(id: number, actor: Actor, reason: string): Promise<void> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(stockAdjustmentRequests).where(eq(stockAdjustmentRequests.id, id)).for("update").limit(1)
    )[0];
    if (!r) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر رفض تسوية المخزون",
          why: `طلب التسوية رقم ${id} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «طلبات تسوية المخزون» واختر طلباً قائماً من القائمة الحاليّة",
        }),
      });
    }
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر رفض تسوية المخزون",
          why: `الطلب ليس في انتظار الموافقة — حالته الحاليّة ${r.status}`,
          doThis: "حدّث شاشة «طلبات تسوية المخزون» لترى القرار الحاليّ",
        }),
      });
    }
    assertIndependentInventoryReviewer({ createdBy: r.createdBy != null ? Number(r.createdBy) : null, branchId: Number(r.branchId) }, actor, "رفض");
    const trimmed = reason.trim().slice(0, 500);
    if (!trimmed) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر رفض تسوية المخزون",
          why: "سبب الرفض إلزاميّ للسجل التدقيقيّ ولم يصل سببٌ مكتوب",
          doThis: "اكتب سبباً واضحاً للرفض في «سبب الرفض» ثم أعد الإرسال",
        }),
      });
    }
    await tx.update(stockAdjustmentRequests).set({
      status: "REJECTED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      rejectionReason: trimmed,
    }).where(eq(stockAdjustmentRequests.id, id));
  });
}

/** قائمة طلبات التسوية (اسم الصنف + المُنشئ + الرصيد الحاليّ) — معزولةٌ بالفرع، مرتَّبة بالأحدث. */
export async function listStockAdjustmentRequests(scope: {
  branchId?: number | null;
  status?: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  /** `ASC` = الأقدم أوّلاً لصندوق القرارات — القصّ (500) بالأحدث يُسقط أكثر الطلبات تأخّراً. */
  order?: "ASC" | "DESC";
}) {
  const db = requireDb();
  const creator = users;
  const conds = [];
  if (scope.branchId != null) conds.push(eq(stockAdjustmentRequests.branchId, scope.branchId));
  if (scope.status) conds.push(eq(stockAdjustmentRequests.status, scope.status));
  const rows = await db
    .select({
      id: stockAdjustmentRequests.id,
      variantId: stockAdjustmentRequests.variantId,
      branchId: stockAdjustmentRequests.branchId,
      targetQuantity: stockAdjustmentRequests.targetQuantity,
      expectedQuantity: stockAdjustmentRequests.expectedQuantity,
      currentQuantity: branchStock.quantity,
      notes: stockAdjustmentRequests.notes,
      reason: stockAdjustmentRequests.reason,
      // شارةُ «مرفقٌ موجود» فقط — لا نُرسل الـdata URL في القوائم (حجمٌ ضخم، وأمان: يُقرأ عبر
      // إجراءٍ منفصلٍ عند فتح الطلب).
      hasAttachment: sql<number>`CASE WHEN ${stockAdjustmentRequests.attachmentUrl} IS NOT NULL THEN 1 ELSE 0 END`,
      status: stockAdjustmentRequests.status,
      createdBy: stockAdjustmentRequests.createdBy,
      createdByName: creator.name,
      createdAt: stockAdjustmentRequests.createdAt,
      approvedBy: stockAdjustmentRequests.approvedBy,
      approvedAt: stockAdjustmentRequests.approvedAt,
      rejectionReason: stockAdjustmentRequests.rejectionReason,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
    })
    .from(stockAdjustmentRequests)
    .leftJoin(productVariants, eq(stockAdjustmentRequests.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(creator, eq(stockAdjustmentRequests.createdBy, creator.id))
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, stockAdjustmentRequests.variantId), eq(branchStock.branchId, stockAdjustmentRequests.branchId)),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(scope.order === "ASC" ? asc(stockAdjustmentRequests.id) : desc(stockAdjustmentRequests.id))
    .limit(500);
  return rows.map((row) => ({
    ...row,
    notes: decodeAdjustmentNotes(row.notes).human,
    hasAttachment: Number(row.hasAttachment) === 1,
  }));
}

/**
 * قراءةُ data URL للمرفق بشكلٍ مستقلّ — نبقيه خارج قائمة `listStockAdjustmentRequests` كي لا نغرق
 * القائمة بحمولات ~7MB لكل صفّ. الشاشة تفتح المرفق عند الطلب. عزلُ الفرع مطبَّقٌ على الاستدعاء
 * (الراوتر يُمرّر actor.branchId لغير admin) — هنا نُعيد بلا فحصٍ إضافيّ لأنّ الاستدعاء داخليّ.
 */
export async function readAdjustmentAttachment(id: number): Promise<{ attachmentUrl: string | null }> {
  const db = requireDb();
  const rows = await db
    .select({ attachmentUrl: stockAdjustmentRequests.attachmentUrl })
    .from(stockAdjustmentRequests)
    .where(eq(stockAdjustmentRequests.id, id))
    .limit(1);
  return { attachmentUrl: rows[0]?.attachmentUrl ?? null };
}
