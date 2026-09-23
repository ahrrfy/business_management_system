// إنشاء أمر شغل (RECEIVED) — لا يُستهلَك المخزون بعد؛ عربون مقبوض عند الإنشاء إن وُجد.
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  productionRecipeLines,
  productionRecipes,
  products,
  productUnits,
  productVariants,
  receipts,
  shifts,
  users,
  workOrderImages,
  workOrderMaterials,
  workOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { postEntry } from "../ledgerService";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { assertTelecomCollectAllowed } from "../reception/telecom";
import { type Actor, withTx } from "../tx";
import { nextWorkOrderNumber } from "./helpers";
import type { CreateWorkOrderInput } from "./types";
import type { Tx } from "../../db";
import { paymentAssetRole } from "../sale/paymentPosting";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";
import { assertStockedOwnedMaterials } from "../inventory/materialEligibility";
import { exactRecipeMaterialQuantity } from "../serviceRecipeConsumption";
import {
  createWorkOrderDesignRevisionTx,
  normalizeDesignContentImages,
} from "./designApproval";

async function recipeMaterialScopeIds(
  tx: Tx,
  outputVariantId: number,
): Promise<number[]> {
  const heads = await tx
    .select({ id: productionRecipes.id })
    .from(productionRecipes)
    .where(eq(productionRecipes.outputVariantId, outputVariantId))
    .orderBy(productionRecipes.id);
  if (!heads.length) return [];
  const lines = await tx
    .select({ inputVariantId: productionRecipeLines.inputVariantId })
    .from(productionRecipeLines)
    .where(
      inArray(
        productionRecipeLines.recipeId,
        heads.map((head) => Number(head.id)),
      ),
    )
    .orderBy(productionRecipeLines.inputVariantId);
  return Array.from(
    new Set(lines.map((line) => Number(line.inputVariantId))),
  ).sort((a, b) => a - b);
}

/**
 * يقرأ تعريف خدمةٍ قراءةً حالية بعد قفل نطاق output+materials. لا نستعمل هنا
 * consistent read العام لأن المعاملة ربما انتظرت كاتب وصفة ثم بقيت على لقطة RR أقدم.
 */
async function loadLockedServiceRecipeLines(
  tx: Tx,
  outputVariantId: number,
  lockedScope: ReadonlySet<number>,
): Promise<Array<{ inputVariantId: number; qtyPerOutputBase: string }> | null> {
  const heads = await tx
    .select({
      id: productionRecipes.id,
      isActive: productionRecipes.isActive,
    })
    .from(productionRecipes)
    .where(eq(productionRecipes.outputVariantId, outputVariantId))
    .orderBy(productionRecipes.id)
    .for("update");
  const active = heads.filter((head) => head.isActive === true);
  if (active.length > 1) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر إنشاء أمر الشغل للخدمة #${outputVariantId}`,
        why: "مرتبطة بأكثر من وصفة مواد فعّالة",
        doThis: "عطّل الوصفات الزائدة واترك وصفة فعّالة واحدة فقط",
      }),
    });
  }
  if (!active.length) {
    if (!heads.length) return null;
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر إنشاء أمر الشغل للخدمة #${outputVariantId}`,
        why: "وصفة مواد الخدمة معطلة حالياً رغم وجود تعريف تاريخي لها",
        doThis: "فعّل وصفة مواد واحدة أو راجع إعداد الخدمة",
      }),
    });
  }

  const recipeId = Number(active[0].id);
  const rows = await tx
    .select({
      inputVariantId: productionRecipeLines.inputVariantId,
      qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
    })
    .from(productionRecipeLines)
    .where(eq(productionRecipeLines.recipeId, recipeId))
    .orderBy(productionRecipeLines.id)
    .for("update");
  if (!rows.length) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `وصفة الخدمة #${recipeId} غير قابلة للتنفيذ`,
        why: "وصفة مواد الخدمة فعالة لكنها بلا مواد",
        doThis: "أضف مواد الوصفة أو عطّلها قبل إنشاء أمر الشغل",
      }),
    });
  }
  const lines = rows.map((row) => ({
    inputVariantId: Number(row.inputVariantId),
    qtyPerOutputBase: String(row.qtyPerOutputBase),
  }));
  const outsideScope = lines.find(
    (line) => !lockedScope.has(line.inputVariantId),
  );
  if (outsideScope) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تغيّرت وصفة الخدمة أثناء إنشاء أمر الشغل",
        why: `أُضيفت المادة #${outsideScope.inputVariantId} بعد تجهيز نطاق الأقفال`,
        doThis: "أعد المحاولة لقراءة الوصفة الجديدة كاملةً",
      }),
    });
  }
  await assertStockedOwnedMaterials(
    tx,
    lines.map((line) => line.inputVariantId),
    "مكوّن وصفة الخدمة",
  );
  return lines;
}

async function requireLockedReceptionShift(
  tx: Tx,
  actor: Actor,
  branchId: number,
  explicitShiftId: number | null,
  label: string,
): Promise<number> {
  const conditions = [
    eq(shifts.branchId, branchId),
    eq(shifts.status, "OPEN"),
    eq(shifts.shiftType, "RECEPTION"),
  ];
  if (explicitShiftId != null) conditions.push(eq(shifts.id, explicitShiftId));
  else conditions.push(eq(shifts.userId, actor.userId));
  const row = (
    await tx
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(...conditions))
      .for("update")
      .limit(1)
  )[0];
  if (!row) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `افتح وردية استقبال في هذا الفرع قبل ${label}؛ لا يجوز تسجيل نقد DRAWER بلا وردية RECEPTION مقفلة`,
    });
  }
  return Number(row.id);
}

/** Create a work order in RECEIVED status — stock is NOT consumed yet. */
export async function createWorkOrderInTx(
  tx: Tx,
  input: CreateWorkOrderInput,
  actor: Actor,
) {
  const requestFingerprint = input.clientRequestId
    ? idempotencyHash(input)
    : null;
  // الطريقة تغطّي عربون الأمر وأجرة التوصيل المقبوضة في الاستقبال؛ نغلقها
  // قبل idempotency وإنشاء الأمر حتى لا يبقى أثر تشغيلي من قبض مرفوض.
  if (input.paymentMethod != null)
    assertPosPaymentMethodEnabled(input.paymentMethod);
  // idempotency: إعادة طلب بنفس المفتاح ⇒ نُعيد الأمر الأول دون إنشاء/قبض عربون ثانٍ.
  const replayId = await checkIdempotency(
    tx,
    "workOrder.create",
    input.clientRequestId,
    requestFingerprint,
  );
  if (replayId) {
    const ex = (
      await tx
        .select({ orderNumber: workOrders.orderNumber })
        .from(workOrders)
        .where(eq(workOrders.id, replayId))
        .limit(1)
    )[0];
    return {
      workOrderId: replayId,
      orderNumber: ex?.orderNumber ?? "",
      idempotent: true,
    };
  }
  if (!input.title.trim())
    throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان الأمر مطلوب" });
  if (!input.salePrice || money(input.salePrice).lte(0))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سعر البيع يجب أن يكون موجباً",
    });
  if (
    actor.role != null &&
    actor.role !== "admin" &&
    actor.role !== "manager" &&
    money(input.laborCost ?? "0").gt(0)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "تكلفة العمالة لا يحددها الكاشير؛ يلزم مسار إداري موثّق",
    });
  }
  const qty = Math.trunc(input.quantity ?? 1);
  if (!Number.isInteger(qty) || qty <= 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الكمية يجب أن تكون عدداً صحيحاً موجباً",
    });
  // تدقيق ١٧/٧: العربون لا يتجاوز سعر البيع الإجمالي (السعر ثابت لحظة الإنشاء) — عربون أكبر كان يُقبل
  // ثم يجعل الأمر غير قابل للتسليم نهائياً (deliver يرفض totalPaid > salePrice). الإشارة السالبة مصدودة بـzod.
  if (round2(money(input.deposit ?? "0")).gt(money(input.salePrice)))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "العربون لا يمكن أن يتجاوز سعر البيع الإجمالي للأمر",
    });

  // الإسناد عند الإنشاء تنفيذٌ تشغيلي، لا اختيار حساب عام: فني مطبعة فعّال من الفرع أو فني مشترك فقط.
  // تركه null يضع الأمر في الطابور الوارد ليسحبه الفني من محطة التنفيذ.
  if (input.assignedTo != null) {
    const assignee = (
      await tx
        .select({
          role: users.role,
          branchId: users.branchId,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, input.assignedTo))
        .limit(1)
    )[0];
    if (
      !assignee ||
      !assignee.isActive ||
      assignee.role !== "print_operator" ||
      (assignee.branchId != null &&
        Number(assignee.branchId) !== Number(input.branchId))
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "يمكن إسناد أمر الشغل إلى فني مطبعة من الفرع فقط",
      });
    }
  }

  // القائمة الصريحة تبقى ذات الأولوية. عند خلوّها فقط، تستمد خدمةٌ ذات وصفة موادها من BOM؛
  // الخدمة التي لم يكن لها أي تاريخ وصفة تبقى عملاً خالصاً مشروعاً بلا مواد.
  const requestedMaterials = [...(input.materials ?? [])];
  for (const m of requestedMaterials) {
    if (
      !Number.isInteger(m.variantId) ||
      m.variantId <= 0 ||
      !Number.isInteger(m.baseQuantity) ||
      m.baseQuantity <= 0
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "كميات المواد يجب أن تكون أعداداً صحيحة موجبة",
      });
  }
  const materialQuantities = new Map<number, number>();
  for (const material of requestedMaterials) {
    const total =
      (materialQuantities.get(material.variantId) ?? 0) +
      material.baseQuantity;
    if (!Number.isSafeInteger(total)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تجميع كمية المادة #${material.variantId}`,
          why: "الكمية تتجاوز الحد العددي الآمن",
          doThis: "خفّض كمية المادة ثم أعد المحاولة",
        }),
      });
    }
    materialQuantities.set(material.variantId, total);
  }
  let materials = Array.from(materialQuantities, ([variantId, baseQuantity]) => ({
    variantId,
    baseQuantity,
  })).sort((a, b) => a.variantId - b.variantId);

  // v3-add-screens(100%): baseVariantId اختياري — طلب خدمة قد يكون خدمة تخصيص بلا منتج خام.
  // نقرأ نطاق الوصفة أولاً بلا قفل، ثم نقفل output+materials في SELECT واحد مرتب. هذا يطابق
  // ترتيب كاتب الوصفة ويمنع دورة output→material مقابل material→output.
  let baseIsService = false;
  let baseProductUnitId: number | null = null;
  let baseBaseQuantity: number | null = null;
  let baseConsumesInventory: boolean | null = null;
  let lockedBaseScope = new Set<number>();
  if (input.baseVariantId == null && input.baseProductUnitId != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إنشاء أمر الشغل",
        why: "أُرسلت وحدة منتج بلا صنف أساس",
        doThis: "اختر الصنف الأساس والوحدة معاً، أو اتركهما معاً لخدمة خالصة",
      }),
    });
  }
  if (input.baseVariantId != null) {
    const recipeScope = materials.length === 0
      ? await recipeMaterialScopeIds(tx, input.baseVariantId)
      : [];
    const scopeIds = Array.from(
      new Set([
        input.baseVariantId,
        ...materials.map((material) => material.variantId),
        ...recipeScope,
      ]),
    ).sort((a, b) => a - b);
    const lockedScope = await tx
      .select({
        id: productVariants.id,
        isService: products.isService,
        productName: products.name,
        productActive: products.isActive,
        variantActive: productVariants.isActive,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, scopeIds))
      .orderBy(productVariants.id)
      .for("update");
    lockedBaseScope = new Set(lockedScope.map((row) => Number(row.id)));
    const base = lockedScope.find(
      (row) => Number(row.id) === input.baseVariantId,
    );
    if (!base)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "المنتج الأساس لطلب الخدمة غير موجود",
      });
    if (base.productActive !== true || base.variantActive !== true) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `المنتج الأساس «${base.productName}» معطّل`,
          why: "المنتج أو متغيّره ليس نشطاً عند إنشاء أمر الشغل",
          doThis: "فعّل المنتج ومتغيّره، أو اختر منتجاً أساساً نشطاً",
        }),
      });
    }
    baseIsService = base.isService === true;
    baseConsumesInventory = !baseIsService;

    const selectedUnits = input.baseProductUnitId != null
      ? await tx
          .select({
            id: productUnits.id,
            variantId: productUnits.variantId,
            conversionFactor: productUnits.conversionFactor,
            isActive: productUnits.isActive,
          })
          .from(productUnits)
          .where(eq(productUnits.id, input.baseProductUnitId))
          .for("update")
          .limit(1)
      : await tx
          .select({
            id: productUnits.id,
            variantId: productUnits.variantId,
            conversionFactor: productUnits.conversionFactor,
            isActive: productUnits.isActive,
          })
          .from(productUnits)
          .where(
            and(
              eq(productUnits.variantId, input.baseVariantId),
              eq(productUnits.isActive, true),
            ),
          )
          .orderBy(desc(productUnits.isBaseUnit), asc(productUnits.id))
          .for("update")
          .limit(1);
    const selectedUnit = selectedUnits[0];
    if (
      !selectedUnit ||
      Number(selectedUnit.variantId) !== input.baseVariantId ||
      selectedUnit.isActive !== true
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر تثبيت وحدة الصنف الأساس",
          why: input.baseProductUnitId != null
            ? "الوحدة المختارة لا تخص الصنف الأساس أو أنها معطلة"
            : "لا توجد للصنف الأساس وحدة نشطة قابلة للحفظ",
          doThis: "اختر وحدة نشطة تخص الصنف ثم أعد إنشاء أمر الشغل",
        }),
      });
    }
    baseProductUnitId = Number(selectedUnit.id);
    baseBaseQuantity = exactRecipeMaterialQuantity(
      String(selectedUnit.conversionFactor),
      qty,
      "كمية الصنف الأساس",
    );
  }

  if (materials.length === 0 && baseIsService && input.baseVariantId != null) {
    const recipeLines = await loadLockedServiceRecipeLines(
      tx,
      input.baseVariantId,
      lockedBaseScope,
    );
    if (recipeLines) {
      const derived = new Map<number, number>();
      for (const line of recipeLines) {
        const lineQuantity = exactRecipeMaterialQuantity(
          line.qtyPerOutputBase,
          baseBaseQuantity!,
          `مادة وصفة الخدمة #${line.inputVariantId}`,
        );
        const total = (derived.get(line.inputVariantId) ?? 0) + lineQuantity;
        if (!Number.isSafeInteger(total)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذّر اشتقاق مواد أمر الشغل",
              why: `كمية مادة وصفة الخدمة #${line.inputVariantId} تتجاوز الحد الآمن`,
              doThis: "خفّض كمية الأمر أو عدّل وصفة الخدمة ثم أعد المحاولة",
            }),
          });
        }
        derived.set(line.inputVariantId, total);
      }
      materials = Array.from(derived, ([variantId, baseQuantity]) => ({
        variantId,
        baseQuantity,
      })).sort((a, b) => a.variantId - b.variantId);
    }
  }

  // الصنف الأساس المادي حصة إلزامية يشتقها الخادم من الوحدة المختارة. إن كانت الواجهة
  // قد أرسلته ضمن المواد فلا نضاعفه؛ نحفظ الأكبر كي تبقى الزيادة المقصودة مادةً إضافية.
  if (
    input.baseVariantId != null &&
    baseConsumesInventory === true &&
    baseBaseQuantity != null
  ) {
    const explicit = materials.find(
      (material) => material.variantId === input.baseVariantId,
    )?.baseQuantity ?? 0;
    const mergedQuantity = Math.max(explicit, baseBaseQuantity);
    materials = materials.filter(
      (material) => material.variantId !== input.baseVariantId,
    );
    materials.push({
      variantId: input.baseVariantId,
      baseQuantity: mergedQuantity,
    });
    materials.sort((a, b) => a.variantId - b.variantId);
  }
  await assertStockedOwnedMaterials(
    tx,
    materials.map((material) => material.variantId),
    "مادة أمر الشغل",
  );

  // البطاقة/التحويل/المحفظة مسارات غير نقدية قابلة للمطابقة؛ يلزم مرجع يمنع دفعة مجهولة المصدر.
  if (
    (input.paymentMethod === "CARD" ||
      input.paymentMethod === "TRANSFER" ||
      input.paymentMethod === "WALLET") &&
    !input.paymentReference?.trim()
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        input.paymentMethod === "CARD"
          ? "رقم العملية المرجعي مطلوب لدفع البطاقة"
          : input.paymentMethod === "WALLET"
            ? "رقم عملية المحفظة مطلوب"
            : "رقم مرجع التحويل مطلوب",
    });
  }

  const orderNumber = await nextWorkOrderNumber(tx, input.branchId);
  const customizationSnapshot = input.customizationText?.trim() || null;
  const insRes = await tx.insert(workOrders).values({
    orderNumber,
    branchId: input.branchId,
    // ش٥ (0238): المسوّدة الجامعة — أوامرُ السلّة الواحدة تصير إخوة.
    draftId: input.draftId ?? null,
    customerId: input.customerId ?? null,
    baseVariantId: input.baseVariantId ?? null,
    baseProductUnitId,
    baseBaseQuantity,
    baseConsumesInventory,
    title: input.title.trim(),
    customizationText: customizationSnapshot,
    quantity: qty,
    materialsCost: "0",
    laborCost: input.laborCost
      ? round2(money(input.laborCost)).toFixed(2)
      : "0.00",
    salePrice: round2(money(input.salePrice)).toFixed(2),
    status: "RECEIVED",
    dueDate: input.dueDate ? new Date(input.dueDate) : null,
    createdBy: actor.userId,
    assignedTo: input.assignedTo ?? null,
    // v3-add-screens(100%): الأعمدة الجديدة تذهب مباشرة لجدول workOrders.
    receptionChannel: input.receptionChannel ?? "WALK_IN",
    channelHandle: input.channelHandle?.trim() || null,
    priority: input.priority ?? "NORMAL",
    deposit: input.deposit ? round2(money(input.deposit)).toFixed(2) : "0.00",
    // صدق طريقة الدفع (١٨/٨): الطريقة تخصّ **العربون**؛ أمرٌ بلا عربون يُختَم NULL. كان
    // `?? "CASH"` (ومعه default القاعدة) يسحق null الصريح القادم من المسوّدة/الواجهة فيُقرأ
    // أمرٌ لم يُقبض فيه دينار كأنّه «دُفع نقداً».
    paymentMethod: round2(money(input.deposit ?? "0")).gt(0)
      ? (input.paymentMethod ?? null)
      : null,
    // paymentMode (٢٨/٨/٢٦، هجرة 0276): افتراضي PREPAID. يُمرَّر 'COD' من مسار الاستقبال
    // لطلبات التوصيل التي سيُحصِّلها المندوب — يُتجاوز فحصُ الائتمان عند التسليم.
    // لطلبات التوصيل أو قنوات الاتصال عن بُعد (واتساب، هاتف، إنستغرام…) يكون الافتراضي COD
    // لضمان عدم حظر الزبائن النقديين عند دفع عربون جزئي مع تحصيل الباقي عند الاستلام أو التوصيل.
    paymentMode: input.paymentMode ?? (
      input.hasDelivery || (input.receptionChannel && input.receptionChannel !== "WALK_IN")
        ? "COD"
        : "PREPAID"
    ),
    paymentReference: input.paymentReference?.trim() || null,
    paymentReceiptUrl: input.paymentReceiptUrl?.trim() || null,
    hasDelivery: !!input.hasDelivery,
    deliveryAddress: input.deliveryAddress?.trim() || null,
    deliveryCost: input.deliveryCost
      ? round2(money(input.deliveryCost)).toFixed(2)
      : "0.00",
    deliveryPhone: input.deliveryPhone?.trim() || null,
    // ٥/٨ — الأجرة تمرير: تُخزَّن في عمودها وحدها ولا تُضمّ إلى salePrice أبداً.
    deliveryFeeCollection: input.deliveryFeeCollection ?? "COURIER",
    contactName: input.contactName?.trim() || null,
    contactPhone: input.contactPhone?.trim() || null,
  });
  const workOrderId = extractInsertId(insRes);
  // سجّل مفتاح الـidempotency فوراً بعد إدراج الأمر — طلبٌ متزامن مكرّر يصطدم بالقيد الفريد فيُلغى (ROLLBACK) قبل قبض العربون.
  if (input.clientRequestId)
    await recordIdempotencyKey(
      tx,
      "workOrder.create",
      input.clientRequestId,
      workOrderId,
      requestFingerprint,
    );

  // عربون مقبوض عند الإنشاء: نقدٌ حقيقي يدخل الصندوق ⇒ سجّله receipt(IN) بـshiftId + قيد PAYMENT_IN
  // (وإلا فهو نقد غير محتسَب في تسوية الوردية/الدفتر). يُربَط بالفاتورة عند التسليم.
  const depositD = round2(money(input.deposit ?? "0"));
  // ش٤ (§٧.٢): جزءٌ من العربون قد يكون قُبض **سلفاً** (عرابين مسوّدة عبر orderPayments) — له
  // إيصاله وقيده منذ لحظة قبضه، والإيصال هنا يُنشأ للجزء **الجديد** وحده (I5: لا إيصال ثانٍ
  // لمالٍ سبق قبضه). عمود deposit يخزّن الكامل (P+N) — هو ما يقرؤه deliver/cancel.
  const depositPreD = round2(money(input.depositPreCollected ?? "0"));
  if (depositPreD.gt(depositD)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "المقبوض سلفاً يتجاوز عربون الأمر — خلل توزيع",
    });
  }
  const newDepositD = round2(depositD.minus(depositPreD));
  // ش٠ (V4): وردية السلة المُتحقَّق منها (من checkoutReception) تُلزِم درجاً واحداً لكل نقد
  // السلة؛ الإنشاء المفرد (بلا shiftId) يبقى على الحلّ الذاتي — يفاضل RECEPTION لو فُتحت وردِيتان.
  const basketShiftId = input.shiftId ?? null;
  if (newDepositD.gt(0)) {
    const depositMethod = input.paymentMethod ?? "CASH";
    // ش٥ (§٩.٤): عربون زين على الإنشاء المفرد المباشر (بلا shiftId من سلة الاستقبال) يمرّ
    // بضوابطه هنا — مسار السلة/المسوّدة أُسقط عنه (checkoutReceptionInTx فحص مبلغ القبض كله
    // سلفاً؛ إعادة الفحص لكل أمرٍ كانت سترفض سلّةً بأمرين على كودٍ واحدٍ مشروع).
    if (depositMethod === "TELECOM" && basketShiftId == null) {
      await assertTelecomCollectAllowed(tx, {
        userId: actor.userId,
        branchId: input.branchId,
        amount: newDepositD.toFixed(2),
        reference: input.paymentReference,
      });
    }
    const shiftId =
      depositMethod === "CASH"
        ? await requireLockedReceptionShift(
            tx,
            actor,
            input.branchId,
            basketShiftId,
            "قبض عربون نقدي",
          )
        : basketShiftId;
    await lockMaterializedCashReceiptSourceForWrite(tx, {
      branchId: input.branchId,
      shiftId,
      cashBucket: depositMethod === "CASH" ? "DRAWER" : null,
      paymentMethod: depositMethod,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    const dRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId,
      workOrderId,
      direction: "IN",
      amount: toDbMoney(newDepositD),
      paymentMethod: depositMethod,
      referenceNumber: input.paymentReference?.trim() || null,
      // cashBucket='DRAWER' للعربون النقدي ⇒ يَدخل تسوية الدرج/Z-report (مرآة دفعة التسليم/البيع).
      // كان NULL ⇒ يُستثنى من computeExpectedCash (cashBucket='DRAWER') ⇒ فائضٌ زائف عند إقفال وردية الاستقبال.
      cashBucket: depositMethod === "CASH" ? "DRAWER" : null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: actor.userId,
    });
    const depositReceiptId = extractInsertId(dRes);
    // ش٠ (V3): هويّة إيصال العربون تُثبَّت على الأمر لحظة قبضه — قرّاؤها (deliver/cancel/dispatch)
    // لم يعودوا يلتقطون بـ`.limit(1)` الملتبسة مع إيصال أجرة COUNTER.
    // (depositReceiptId يحمل إيصال الجزء الجديد N وحده؛ حصص P حقيقتها في orderPayments.)
    await tx
      .update(workOrders)
      .set({ depositReceiptId })
      .where(eq(workOrders.id, workOrderId));
    const depositAssetRole = paymentAssetRole(
      depositMethod,
      depositMethod === "CASH" ? "DRAWER" : null,
      "IN",
    );
    const depositPostingSource = {
      roleDebits: { [depositAssetRole]: newDepositD },
      roleCredits: { OTHER_LIABILITY: newDepositD },
    };
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: input.branchId,
      receiptId: depositReceiptId,
      customerId: input.customerId ?? null,
      amount: newDepositD,
      notes: `[WO_DEPOSIT:${workOrderId}]`,
      paymentMethod: depositMethod, // دلو النقد للدفتر المزدوج (لا يُخزَّن)
      postingIntent: createPostingIntent(
        "PAYMENT_IN_OTHER",
        "PAYMENT_IN",
        [
          debitLine(depositAssetRole, newDepositD),
          creditLine("OTHER_LIABILITY", newDepositD),
        ],
        depositPostingSource,
      ),
      postingSourceComponents: depositPostingSource,
    });
  }

  // ٥/٨ — أجرة توصيل قُبضت في الاستقبال (COUNTER): نقدٌ حقيقيّ يدخل الدرج لكنه **ليس بيعاً**.
  // يُسجَّل إيصالاً مستقلاً عن الفاتورة + قيد DELIVERY_FEE_HELD (مبلغٌ فقط: لا إيراد ولا تكلفة
  // ولا ربح) ⇒ يظهر في «النقد المتوقّع» فيُطابِق الدرج فعلاً، ثم يُبرَّأ حين يُخصَم من توريد
  // المندوب. بلا هذا الإيصال يكون النقد في الدرج بلا مصدرٍ مسجَّل ⇒ فائضٌ يمنع إغلاق الوردية.
  const heldFeeD = round2(money(input.deliveryCost ?? "0"));
  if (
    input.hasDelivery &&
    (input.deliveryFeeCollection ?? "COURIER") === "COUNTER" &&
    heldFeeD.gt(0)
  ) {
    // تدقيق ٦/٨ (ث٩): الأجرة أمانةٌ **نقديّة** تُصرَف للمندوب نقداً من الدرج — فاشتقاق
    // طريقتها من طريقة دفع السلّة كان يقبضها بطاقةً/تحويلاً (خارج الدرج، cashBucket=NULL)
    // ثم يصرفها نقداً ⇒ نقدٌ يخرج بلا نظيرٍ داخل. تُثبَّت نقداً حتماً، مرآةَ مسار الفاتورة
    // (receptionCheckoutService) الذي يفعل ذلك أصلاً. وبهذا يسقط فحص TELECOM من جذره.
    const feeMethod = "CASH" as const;
    // ش٠ (V4): نفس درج السلة المُتحقَّق منه — لا ينشطر نقد سلةٍ واحدة على درجين.
    const feeShiftId = await requireLockedReceptionShift(
      tx,
      actor,
      input.branchId,
      basketShiftId,
      "قبض أجرة توصيل نقداً",
    );
    await lockMaterializedCashReceiptSourceForWrite(tx, {
      branchId: input.branchId,
      shiftId: feeShiftId,
      cashBucket: "DRAWER",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    const feeRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId: feeShiftId,
      workOrderId,
      direction: "IN",
      amount: toDbMoney(heldFeeD),
      paymentMethod: feeMethod,
      referenceNumber: `DLV-FEE-WO-${workOrderId}`,
      cashBucket: feeMethod === "CASH" ? "DRAWER" : null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      description: `أجرة توصيل مقبوضة أمانةً للمندوب — طلب ${orderNumber}`,
      createdBy: actor.userId,
    });
    await postEntry(tx, {
      entryType: "DELIVERY_FEE_HELD",
      dedupeKey: `DELIVERY_FEE_HELD:WO:${workOrderId}`,
      branchId: input.branchId,
      receiptId: extractInsertId(feeRes),
      amount: heldFeeD,
      notes: `أمانة أجرة توصيل — طلب ${orderNumber}`,
      postingSourceComponents: {
        roleDebits: { CASH: heldFeeD },
        roleCredits: { COURIER_PAYABLE: heldFeeD },
      },
      postingIntent: createPostingIntent(
        "DELIVERY_FEE_HELD_RECEIPT",
        "DELIVERY_FEE_HELD",
        [debitLine("CASH", heldFeeD), creditLine("COURIER_PAYABLE", heldFeeD)],
        {
          roleDebits: { CASH: heldFeeD },
          roleCredits: { COURIER_PAYABLE: heldFeeD },
        },
      ),
    });
  }

  for (const m of materials) {
    await tx.insert(workOrderMaterials).values({
      workOrderId,
      variantId: m.variantId,
      baseQuantity: m.baseQuantity,
      isBaseMaterial:
        baseConsumesInventory === true &&
        input.baseVariantId != null &&
        m.variantId === input.baseVariantId,
      unitCost: "0", // snapshot on consumption
    });
  }

  // السلامة المخزنية/المحاسبية (٢١/٦/٢٦): أُزيل إدراج `workOrderItems` (أصناف البيع المصغّرة).
  // كان طلب الخدمة يُخزّنها بلا خصم مخزون (start يستهلك المواد فقط) وبلا تكلفة (COGS) في الفاتورة
  // ⇒ مخزونٌ مُبالَغ فيه وربحٌ مُبالَغ فيه. القرار (أ): الأصناف الجاهزة تُباع بفاتورة بيع مستقلّة
  // عبر saleRouter (خصم مخزون + COGS + قيد SALE)، وطلب الخدمة يحمل خدمة التخصيص فقط. الجدول
  // workOrderItems يبقى في المخطّط (بلا كاتب) تفادياً لهجرة، وقد يُستعمل مستقبلاً لمنطق صحيح.

  // v3-add-screens(100%): صور نموذج العمل في جدولها الصحيح.
  const imgs = normalizeDesignContentImages(
    (input.designImages ?? []).filter((i) => i.url?.trim()).slice(0, 10),
  );
  if (imgs.length > 0) {
    await tx.insert(workOrderImages).values(
      imgs.map((img) => ({
        workOrderId,
        url: img.url,
        caption: img.caption,
        sortOrder: img.sortOrder,
        revision: 1,
      } as any)),
    );
  }

  // رأس نسخة مستقلّ عن الصور: حتى الطلب النصّي أو ذو صفر صور له مستندٌ مبصوم قابل للاعتماد.
  await createWorkOrderDesignRevisionTx(tx, {
    workOrderId,
    branchId: input.branchId,
    revision: 1,
    customizationSnapshot,
    images: imgs,
    reason: "إنشاء أمر الشغل",
    createdBy: actor.userId,
  });

  return { workOrderId, orderNumber };
}

/** Public wrapper for callers that create one work order outside a composed transaction. */
export async function createWorkOrder(
  input: CreateWorkOrderInput,
  actor: Actor,
) {
  return withTx((tx) => createWorkOrderInTx(tx, input, actor));
}
