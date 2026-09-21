// إنشاء مستند إنتاج: يستهلك المدخلات ويُنتج المخرجات ذرّياً + يُحدّث كلفة المخرجات (بلا قيد محاسبي).
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  branchStock,
  productUnits,
  productVariants,
  products,
  productionLines,
  productionOrders,
  productionRecipeLines,
  productionRecipes,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement, ensureBranchStockRows } from "../inventoryService";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
} from "../accounting/postingEngine";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
import { spoilageSplit } from "./calc";
import { nextProductionNumber, resolveLine, resolveRunPlan } from "./helpers";
import type { CreateProductionInput, CreateProductionResult, ResolvedLine, SpoilageParams } from "./types";

/** إنشاء مستند إنتاج: يستهلك المدخلات ويُنتج المخرجات ذرّياً + يُحدّث كلفة المخرجات (بلا قيد محاسبي). */
export async function createProduction(input: CreateProductionInput, actor: Actor): Promise<CreateProductionResult> {
  return withTx(async (tx) => {
    // ① إعادة idempotent.
    const replayId = await checkIdempotency(tx, "production.create", input.clientRequestId, idempotencyHash(input));
    if (replayId) {
      const ex = (
        await tx.select({ docNumber: productionOrders.docNumber, totalCost: productionOrders.totalCost })
          .from(productionOrders).where(eq(productionOrders.id, replayId)).limit(1)
      )[0];
      return { productionOrderId: replayId, docNumber: ex?.docNumber ?? "", totalCost: ex?.totalCost ?? "0.00", idempotent: true };
    }

    // ② تحقّق + تحليل الأسطر (تشغيل بوصفة أو مدخلات/مخرجات يدوية) + حارس التحويل الذاتي.
    const { inLines, outLines, laborCost, spoilage, linkedRecipeId } = await resolveAndValidateLines(tx, input);
    // التصنيف والحالة حقائق حيّة؛ نعيد قراءتها بعد قفل المنتجات ثم المتغيّرات وقبل أول كتابة.
    // هذا المسار مركزيّ فيغطي الإدخال اليدوي وتشغيل الوصفة معاً.
    const lockedVariantCosts = await lockAndValidateProductionVariants(
      tx,
      inLines,
      outLines,
    );
    if (input.run) {
      await assertRunPlanStillCurrent(
        tx,
        input.run,
        inLines,
        outLines,
        laborCost,
        spoilage,
      );
    } else {
      await assertManualUnitsStillCurrent(tx, input, inLines, outLines);
    }

    // ③ رأس المستند (تكاليف مؤقّتة + حقول الإنتاجية إن كان تشغيلاً بوصفة).
    const docNumber = await nextProductionNumber(tx, input.branchId);
    const insRes = await tx.insert(productionOrders).values({
      docNumber,
      branchId: input.branchId,
      status: "CONFIRMED",
      materialsCost: "0",
      laborCost: laborCost.toFixed(2),
      totalCost: "0",
      batchQty: spoilage ? spoilage.batch : null,
      goodQty: spoilage ? spoilage.good : null,
      scrapQty: spoilage ? spoilage.scrap : 0,
      abnormalLoss: "0",
      wasteStdPct: spoilage ? round2(spoilage.wasteStdPct).toFixed(2) : "0",
      notes: input.notes?.trim() || null,
      linkedWorkOrderId: input.linkedWorkOrderId ?? null,
      linkedRecipeId,
      createdBy: actor.userId,
    });
    const productionOrderId = extractInsertId(insRes);
    // سجّل مفتاح idempotency فوراً ⇒ طلب متزامن مكرّر يصطدم بالقيد الفريد فيُلغى قبل أي حركة مخزون.
    if (input.clientRequestId) await recordIdempotencyKey(tx, "production.create", input.clientRequestId, productionOrderId, idempotencyHash(input));

    // ④ المدخلات: snapshot التكلفة + حركات OUT (تصاعدياً بـvariantId لقفل حتمي).
    const materialsCost = await consumeInputs(
      tx,
      input.branchId,
      productionOrderId,
      inLines,
      lockedVariantCosts,
      actor,
    );
    const totalCost = round2(materialsCost.plus(laborCost));

    // تفريق الهدر (مسار الوصفة فقط): الطبيعي يُمتَص في كلفة السليم، غير الطبيعي خسارة منفصلة.
    // allocPool = ما يُحمَّل على المخرجات = totalCost (بلا هدر) أو absorbedCost (= totalCost − abnormalLoss).
    const sp = spoilage ? spoilageSplit(totalCost, spoilage.batch, spoilage.scrap, spoilage.wasteStdPct) : null;
    const allocPool = sp ? sp.absorbedCost : totalCost;

    await tx
      .update(productionOrders)
      .set({
        materialsCost: materialsCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
        abnormalLoss: (sp ? sp.abnormalLoss : new Decimal(0)).toFixed(2),
      })
      .where(eq(productionOrders.id, productionOrderId));

    // ⑤ المخرجات: توزيع allocPool + WAVG + حركات IN.
    await produceOutputs(
      tx,
      input.branchId,
      productionOrderId,
      outLines,
      allocPool,
      lockedVariantCosts,
      actor,
    );

    // ⑤.5 (المرحلة ٦ — ١٩/٦/٢٦): تأكيد حفظ القيمة (WAVG verification).
    //     فاصل تفاضلي: مجموع تكاليف المخرجات يجب أن يطابق allocPool (= totalCost - abnormalLoss).
    //     آخر سطر يمتص بقايا التقريب، فالتساوي مضمون رياضياً. الفحص هنا حارس defensive ضدّ تعديل لاحق.
    const allocatedSumRes = await tx.execute(sql`
      SELECT COALESCE(SUM(CAST(allocatedCost AS DECIMAL(15,2))), 0) AS s
      FROM productionLines WHERE productionOrderId = ${productionOrderId} AND productionLineDirection = 'OUTPUT'
    `);
    const allocRows = (((allocatedSumRes as any)[0] ?? allocatedSumRes) as Array<any>) ?? [];
    const allocSumStr = String(allocRows[0]?.s ?? "0");
    const allocatedTotal = money(allocSumStr);
    const drift = allocatedTotal.minus(allocPool).abs();
    if (drift.gt("0.01")) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `انتهاك حفظ قيمة الإنتاج: مجموع تكاليف المخرجات ${allocatedTotal.toFixed(2)} ≠ allocPool ${allocPool.toFixed(2)} (فرق ${drift.toFixed(2)})`,
      });
    }

    // ⑥ القيد المحاسبي: التحويل أصل↔أصل محايد ⇒ لا قيد على القيمة المُمتَصّة (في المنتج).
    //    الهدر غير الطبيعي فقط ⇒ قيد WASTAGE (خسارة بالكلفة، بلا نقد، **بلا خصم مخزون ثانٍ** — المواد خُصمت
    //    بحركة المدخلات؛ هذا قيد إعادة تصنيف للقيمة من «منتج» إلى «خسارة فترة» يطابق نمط نثرية/تلف المصاريف).
    if (sp && sp.abnormalLoss.gt(0)) {
      await postEntry(tx, {
        entryType: "WASTAGE",
        branchId: input.branchId,
        cost: sp.abnormalLoss,
        amount: sp.abnormalLoss,
        revenue: new Decimal(0),
        profit: round2(new Decimal(0).minus(sp.abnormalLoss)),
        postingIntent: createPostingIntent(
          "WASTAGE_INVENTORY",
          "WASTAGE",
          signedPostingLines("LOSSES", "INVENTORY", sp.abnormalLoss),
        ),
        notes: `هدر إنتاج غير طبيعي — ${docNumber} (${sp.abnormalUnits} وحدة)`,
        dedupeKey: `WASTAGE:PROD:${productionOrderId}`,
      });
    }
    return { productionOrderId, docNumber, totalCost: totalCost.toFixed(2) };
  });
}

function throwConcurrentUnitChange(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تغيّرت وحدة أحد أسطر الإنتاج أثناء تجهيز المستند",
      why: "الوحدة عُطّلت أو نُقلت أو تغيّر معاملها بعد تحويل الكمية إلى الوحدة الأساس",
      doThis: "حدّث الشاشة ثم أعد إدخال الكميات بوحداتها الحالية",
    }),
  });
}

/** يعيد إثبات تحويل الوحدات اليدوية من locking-current rows بعد قفل المنتجات والمتغيّرات. */
async function assertManualUnitsStillCurrent(
  tx: Tx,
  input: CreateProductionInput,
  inLines: ResolvedLine[],
  outLines: ResolvedLine[],
): Promise<void> {
  const requested = [
    ...(input.inputs ?? []).map((line, index) => ({
      line,
      planned: inLines[index],
    })),
    ...(input.outputs ?? []).map((line, index) => ({
      line,
      planned: outLines[index],
    })),
  ].filter(({ line }) => line.productUnitId != null);
  if (!requested.length) return;

  const unitIds = Array.from(
    new Set(requested.map(({ line }) => Number(line.productUnitId))),
  ).sort((a, b) => a - b);
  const rows = await tx
    .select({
      id: productUnits.id,
      variantId: productUnits.variantId,
      isActive: productUnits.isActive,
      conversionFactor: productUnits.conversionFactor,
    })
    .from(productUnits)
    .where(inArray(productUnits.id, unitIds))
    .orderBy(asc(productUnits.id))
    .for("update");
  const byId = new Map(rows.map((row) => [Number(row.id), row]));

  for (const { line, planned } of requested) {
    const unit = byId.get(Number(line.productUnitId));
    if (
      !planned ||
      !unit ||
      unit.isActive !== true ||
      Number(unit.variantId) !== line.variantId ||
      planned.productUnitId !== Number(line.productUnitId)
    ) {
      throwConcurrentUnitChange();
    }
    if (line.quantity != null) {
      const currentBaseQuantity = money(line.quantity).times(
        unit.conversionFactor,
      );
      if (
        !currentBaseQuantity.isInteger() ||
        currentBaseQuantity.lte(0) ||
        currentBaseQuantity.gt(Number.MAX_SAFE_INTEGER) ||
        currentBaseQuantity.toNumber() !== planned.baseQuantity
      ) {
        throwConcurrentUnitChange();
      }
    }
  }
}

function throwConcurrentRecipeChange(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تغيّرت وصفة الإنتاج أثناء تجهيز التشغيل",
      why: "تعريف الناتج أو المواد أو العمالة أو الهدر لم يعد يطابق الخطة المقروءة أولاً",
      doThis: "أعد المحاولة لتوسيع الوصفة الحالية وحساب التشغيل من جديد",
    }),
  });
}

/**
 * `resolveRunPlan` قراءة تمهيدية وقد تثبت لقطة RR قديمة قبل انتظار أقفال الأصناف.
 * بعد حيازة أقفال الخطة نقرأ الرأس/الوحدة/الأسطر locking-current ونرفض الخطة إن تغيّرت؛
 * لا يجوز ترحيل BOM قديمة بعد التزام تعديل وصفة متزامن.
 */
async function assertRunPlanStillCurrent(
  tx: Tx,
  run: NonNullable<CreateProductionInput["run"]>,
  inLines: ResolvedLine[],
  outLines: ResolvedLine[],
  laborCost: Decimal,
  spoilage: SpoilageParams | null,
): Promise<void> {
  const head = (
    await tx
      .select({
        outputVariantId: productionRecipes.outputVariantId,
        outputProductUnitId: productionRecipes.outputProductUnitId,
        laborPerOutputBase: productionRecipes.laborPerOutputBase,
        wasteStdPct: productionRecipes.wasteStdPct,
        isActive: productionRecipes.isActive,
      })
      .from(productionRecipes)
      .where(eq(productionRecipes.id, run.recipeId))
      .for("update")
      .limit(1)
  )[0];
  if (!head || head.isActive !== true || !spoilage || outLines.length !== 1) {
    throwConcurrentRecipeChange();
  }

  const outputUnit = (
    await tx
      .select({
        variantId: productUnits.variantId,
        isBaseUnit: productUnits.isBaseUnit,
        isActive: productUnits.isActive,
      })
      .from(productUnits)
      .where(eq(productUnits.id, Number(head.outputProductUnitId)))
      .for("update")
      .limit(1)
  )[0];
  const currentLines = await tx
    .select({
      inputVariantId: productionRecipeLines.inputVariantId,
      qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
    })
    .from(productionRecipeLines)
    .where(eq(productionRecipeLines.recipeId, run.recipeId))
    .orderBy(productionRecipeLines.id)
    .for("update");

  const output = outLines[0];
  if (
    !outputUnit ||
    outputUnit.isActive !== true ||
    outputUnit.isBaseUnit !== true ||
    Number(outputUnit.variantId) !== Number(head.outputVariantId) ||
    output.variantId !== Number(head.outputVariantId) ||
    output.productUnitId !== Number(head.outputProductUnitId) ||
    output.baseQuantity !== spoilage.good ||
    currentLines.length !== inLines.length
  ) {
    throwConcurrentRecipeChange();
  }

  for (let index = 0; index < currentLines.length; index++) {
    const current = currentLines[index];
    const planned = inLines[index];
    const currentBaseQuantity = money(current.qtyPerOutputBase).times(
      spoilage.batch,
    );
    if (
      !currentBaseQuantity.isInteger() ||
      currentBaseQuantity.lte(0) ||
      currentBaseQuantity.gt(Number.MAX_SAFE_INTEGER) ||
      Number(current.inputVariantId) !== planned.variantId ||
      currentBaseQuantity.toNumber() !== planned.baseQuantity
    ) {
      throwConcurrentRecipeChange();
    }
  }

  const currentLaborPerUnit =
    run.laborPerUnit != null && String(run.laborPerUnit).trim() !== ""
      ? money(run.laborPerUnit)
      : money(head.laborPerOutputBase ?? "0");
  const currentLaborCost = round2(
    currentLaborPerUnit.times(spoilage.batch),
  );
  if (
    !currentLaborCost.eq(laborCost) ||
    !money(head.wasteStdPct ?? "0").eq(spoilage.wasteStdPct)
  ) {
    throwConcurrentRecipeChange();
  }
}

/**
 * يقفل هوية أصناف الإنتاج ويعيد التحقق من أهليتها تحت القفل.
 *
 * ترتيب القفل الحاكم هنا هو products ثم productVariants، وكلاهما تصاعديّ. نقرأ الربط أولاً
 * بلا قفل لاستخراج productIds، ثم نتحقق بعد القفل أن variant لم يُنقل إلى منتج آخر في السباق.
 * كل مدخل ومخرج يجب أن يكون مخزوناً مملوكاً نشطاً؛ الخدمة والبكج والأمانة لا تمثّل أصلاً
 * مخزنياً يمكن لأمر الإنتاج استهلاكه أو إنشاء WAVG له.
 */
async function lockAndValidateProductionVariants(
  tx: Tx,
  inLines: ResolvedLine[],
  outLines: ResolvedLine[],
): Promise<Map<number, string>> {
  const allVariantIds = Array.from(
    new Set(inLines.concat(outLines).map((line) => line.variantId)),
  ).sort((a, b) => a - b);
  const refs = await tx
    .select({ id: productVariants.id, productId: productVariants.productId })
    .from(productVariants)
    .where(inArray(productVariants.id, allVariantIds))
    .orderBy(asc(productVariants.id));
  const refByVariant = new Map(
    refs.map((row) => [Number(row.id), Number(row.productId)]),
  );
  const missingBeforeLock = allVariantIds.filter(
    (variantId) => !refByVariant.has(variantId),
  );
  if (missingBeforeLock.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: `تعذّر العثور على الصنف #${missingBeforeLock[0]}`,
        why: "المعرّف يشير إلى متغيّر منتج محذوف أو غير موجود",
        doThis: "أعد اختيار الصنف من قائمة المنتجات (قد يكون حُذف أو دُمج)",
      }),
    });
  }

  const productIds = Array.from(new Set(refByVariant.values())).sort(
    (a, b) => a - b,
  );
  const lockedProducts = await tx
    .select({
      id: products.id,
      name: products.name,
      isActive: products.isActive,
      isService: products.isService,
      isBundle: products.isBundle,
      isConsignment: products.isConsignment,
    })
    .from(products)
    .where(inArray(products.id, productIds))
    .orderBy(asc(products.id))
    .for("update");
  const productById = new Map(
    lockedProducts.map((product) => [Number(product.id), product]),
  );

  const lockedVariants = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      isActive: productVariants.isActive,
      costPrice: productVariants.costPrice,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, allVariantIds))
    .orderBy(asc(productVariants.id))
    .for("update");
  const variantById = new Map(
    lockedVariants.map((variant) => [Number(variant.id), variant]),
  );
  const outputIds = new Set(outLines.map((line) => line.variantId));

  for (const variantId of allVariantIds) {
    const variant = variantById.get(variantId);
    if (!variant) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّر العثور على الصنف #${variantId}`,
          why: "المتغيّر حُذف أثناء تجهيز أمر الإنتاج",
          doThis: "حدّث الصفحة ثم أعد اختيار الصنف",
        }),
      });
    }
    const expectedProductId = refByVariant.get(variantId)!;
    const actualProductId = Number(variant.productId);
    if (actualProductId !== expectedProductId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تغيّر ربط الصنف أثناء تجهيز أمر الإنتاج",
          why: `نُقل المتغيّر #${variantId} إلى منتج آخر قبل تثبيت الأقفال`,
          doThis: "حدّث الصفحة ثم أعد المحاولة",
        }),
      });
    }
    const product = productById.get(actualProductId);
    if (!product) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تغيّر المنتج أثناء تجهيز أمر الإنتاج",
          why: `لم يعد منتج المتغيّر #${variantId} مطابقاً للقفل المأخوذ`,
          doThis: "حدّث الصفحة ثم أعد المحاولة",
        }),
      });
    }

    const role = outputIds.has(variantId) ? "مخرج الإنتاج" : "مدخل الإنتاج";
    const label = product.name || `#${variantId}`;
    if (product.isActive !== true || variant.isActive !== true) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `${role} «${label}» معطّل`,
          why: "المنتج أو متغيّره ليس نشطاً وقت ترحيل أمر الإنتاج",
          doThis: "فعّل المنتج ومتغيّره، أو اختر صنفاً نشطاً ثم أعد المحاولة",
        }),
      });
    }
    if (product.isService) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `${role} «${label}» خدمة بلا مخزون`,
          why: "الخدمة لا تملك رصيداً ذاتياً يمكن استهلاكه أو إنتاجه",
          doThis: "اختر صنفاً مخزنياً مملوكاً، واستعمل الخدمة في مسار البيع",
        }),
      });
    }
    if (product.isBundle) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `${role} «${label}» بكج بلا رصيد ذاتي`,
          why: "رصيد البكج هو رصيد مكوّناته، فلا يُستهلك أو يُنتج كسطر مستقل",
          doThis: "استعمل مكوّنات البكج المخزنية بدلاً منه",
        }),
      });
    }
    if (product.isConsignment) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `${role} «${label}» بضاعة أمانة`,
          why: "أصل الأمانة غير مملوك للمنشأة ولا يدخل تحويل الإنتاج أو WAVG المملوك",
          doThis: "اختر صنفاً مخزنياً مملوكاً للمنشأة",
        }),
      });
    }
  }
  // هذه القيم أتت من locking read بعد انتظار أي شراء/WAVG سابق؛ إعادة قراءتها
  // لاحقاً بـconsistent SELECT قد تعيد لقطة RR أقدم من القفل.
  return new Map(
    lockedVariants.map((variant) => [
      Number(variant.id),
      String(variant.costPrice ?? "0"),
    ]),
  );
}
/**
 * تحقّق + تحليل أسطر الإنتاج: «تشغيل بوصفة» (الخادم يوسّع) أو مدخلات/مخرجات يدوية،
 * ثم حارس التحويل الذاتي. الوجود والحالة والتصنيف تُحسم لاحقاً تحت الأقفال المركزية.
 * يُعيد الأسطر المحلولة + العمالة + الهدر + الوصفة المرتبطة.
 */
async function resolveAndValidateLines(
  tx: Tx,
  input: CreateProductionInput,
): Promise<{
  inLines: ResolvedLine[];
  outLines: ResolvedLine[];
  laborCost: Decimal;
  spoilage: SpoilageParams | null;
  linkedRecipeId: number | null;
}> {
  let inLines: ResolvedLine[];
  let outLines: ResolvedLine[];
  let laborCost: Decimal;
  let spoilage: SpoilageParams | null = null;
  let linkedRecipeId: number | null = input.linkedRecipeId ?? null;

  if (input.run) {
    const plan = await resolveRunPlan(tx, input.run);
    inLines = plan.inLines;
    outLines = plan.outLines;
    laborCost = plan.laborCost;
    spoilage = plan.spoilage;
    linkedRecipeId = input.run.recipeId;
  } else {
    if (!input.inputs?.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن ترحيل أمر إنتاج",
          why: "قائمة المدخلات فارغة — الإنتاج يلزمه مادة خام واحدة على الأقل",
          doThis: "أضف مدخلاً واحداً على الأقل من زر «إضافة مدخل»، أو اختر تشغيلاً بوصفة جاهزة",
        }),
      });
    if (!input.outputs?.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن ترحيل أمر إنتاج",
          why: "قائمة المخرجات فارغة — الإنتاج يلزمه منتج نهائي واحد على الأقل",
          doThis: "أضف مخرجاً واحداً على الأقل من زر «إضافة مخرج»، أو اختر تشغيلاً بوصفة جاهزة",
        }),
      });
    inLines = [];
    for (const l of input.inputs) inLines.push(await resolveLine(tx, l));
    outLines = [];
    for (const l of input.outputs) outLines.push(await resolveLine(tx, l));
    laborCost = round2(money(input.laborCost ?? "0"));
    if (laborCost.isNegative())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "قيمة العمالة غير صالحة",
          why: `تكلفة العمالة يجب أن تكون صفراً أو موجباً (السالب يعني «عمالة تخصم»، لا معنى محاسبياً له)`,
          doThis: "أدخل قيمة عمالة موجبة أو صفراً في حقل «تكلفة العمالة»",
        }),
      });
  }

  // التحويل الذاتي ممنوع دائماً: السماح به مع تكلفة تشغيل/عمالة كان يتيح رفع WAVG لنفس الصنف
  // بلا تغيّر صافٍ في الكمية ولا مستند مصدر للقيمة.
  const inVarIds = new Set(inLines.map((l) => l.variantId));
  for (const o of outLines) {
    if (inVarIds.has(o.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تحويلٌ ذاتي ممنوع",
          why: "الصنف نفسه لا يكون مدخلاً ومخرجاً في أمر إنتاج واحد — التحويل الذاتي يرفع WAVG بلا تغيّر كمّي ولا مصدر قيمة",
          doThis: "اقسم العملية إلى أمرين مستقلّين، أو استعمل «تحويل بين فروع» إن كان القصد نقلاً لا إنتاجاً",
        }),
      });
    }
  }

  // افشل قبل أي حركة مخزون إذا كانت نسب التوزيع اليدوي غير صالحة.
  const manualShares = outLines.filter((l) => l.manualSharePct != null);
  if (manualShares.length > 0) {
    if (manualShares.length !== outLines.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "توزيع تكلفة المخرجات غير متّسق",
          why: "بعض المخرجات لها نسبة يدوية والباقي بلا نسبة — لا يجوز خلط الأسلوبين على أمرٍ واحد",
          doThis: "إمّا حدّد نسبة يدوية لكل مخرج (مجموعها 100%)، أو احذف كل النسب لتوزيع تناسبي بحسب الكميات",
        }),
      });
    }
    for (const l of manualShares) {
      const pct = money(l.manualSharePct ?? "0");
      if (pct.lt(0) || pct.gt(100)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نسبة توزيع تكلفة غير صالحة",
            why: `نسبة توزيع كل مخرج يجب أن تكون بين 0% و100%، والقيمة المرسلة (${pct.toFixed(2)}%) خارج النطاق`,
            doThis: "أصلح النسبة إلى قيمة بين 0 و100، أو احذفها لاستعمال التوزيع التناسبي",
          }),
        });
      }
    }
    const sumPct = manualShares.reduce((sum, l) => sum.plus(money(l.manualSharePct ?? "0")), new Decimal(0));
    if (sumPct.minus(100).abs().gt("0.01")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "مجموع نسب التوزيع لا يساوي 100%",
          why: `مجموع نسب المخرجات ${sumPct.toFixed(2)}% — لا 100% كما تشترط قسمة التكلفة الكاملة`,
          doThis: `عدّل النسب حتى يصير مجموعها 100%، أو احذفها كلّها لاستعمال التوزيع التناسبي`,
        }),
      });
    }
  }

  return { inLines, outLines, laborCost, spoilage, linkedRecipeId };
}

/** المدخلات: snapshot التكلفة + حركات OUT (تصاعدياً بـvariantId لقفل حتمي). يُعيد كلفة المواد (round2). */
async function consumeInputs(
  tx: Tx,
  branchId: number,
  productionOrderId: number,
  inLines: ResolvedLine[],
  lockedVariantCosts: ReadonlyMap<number, string>,
  actor: Actor,
): Promise<Decimal> {
  inLines.sort((a, b) => a.variantId - b.variantId);

  let materialsCost = new Decimal(0);
  for (const l of inLines) {
    const unitCost = round2(money(lockedVariantCosts.get(l.variantId) ?? "0"));
    const lineCost = round2(unitCost.times(l.baseQuantity));
    materialsCost = materialsCost.plus(lineCost);
    await tx.insert(productionLines).values({
      productionOrderId,
      direction: "INPUT",
      variantId: l.variantId,
      productUnitId: l.productUnitId,
      quantity: l.quantity,
      baseQuantity: l.baseQuantity,
      unitCost: unitCost.toFixed(2),
      lineCost: lineCost.toFixed(2),
    });
    await applyMovement(tx, {
      variantId: l.variantId,
      branchId,
      baseQuantity: l.baseQuantity,
      movementType: "OUT",
      // «يُباع بالطلب» سياسة بيع، لا ترخيص لاستهلاك مادة خام غير موجودة
      // أو محجوزة لطلب آخر داخل أمر إنتاج.
      respectProductBackorder: false,
      referenceType: "PRODUCTION",
      referenceId: productionOrderId,
      createdBy: actor.userId,
    });
  }
  return round2(materialsCost);
}

/**
 * المخرجات: تحقّق التوزيع (يدوي كلّه أو لا شيء بمجموع ≈100، أو تناسبي)، ثم قفل رصيد المخرجات
 * وقراءة SUM العالمي **قبل** أي إدخال، ثم توزيع allocPool + WAVG على كلفة كل مخرَج + حركات IN.
 */
async function produceOutputs(
  tx: Tx,
  branchId: number,
  productionOrderId: number,
  outLines: ResolvedLine[],
  allocPool: Decimal,
  lockedVariantCosts: ReadonlyMap<number, string>,
  actor: Actor,
): Promise<void> {
  outLines.sort((a, b) => a.variantId - b.variantId);
  const totalOutBase = outLines.reduce((s, l) => s + l.baseQuantity, 0);
  if (totalOutBase <= 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "كمية المخرجات غير صالحة",
        why: "مجموع كميات المخرجات صفر أو أقلّ — أمر إنتاجٍ بلا وحدة ناتجة لا يمكن أن يوزّع تكلفةً",
        doThis: "أدخل كمية موجبة لكل مخرج، وتحقّق من صحة وحدات القياس المستعملة",
      }),
    });

  // توزيع يدوي: كلّه أو لا شيء، بمجموع ≈ 100.
  const manualCount = outLines.filter((l) => l.manualSharePct != null).length;
  const useManual = manualCount > 0;
  if (useManual && manualCount !== outLines.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "توزيع تكلفة المخرجات غير متّسق",
        why: `بعض المخرجات (${manualCount} من ${outLines.length}) لها نسبة يدوية والباقي بلا نسبة — لا يجوز خلط الأسلوبين`,
        doThis: "إمّا حدّد نسبة يدوية لكل مخرج (مجموعها 100%)، أو احذف كل النسب لتوزيع تناسبي بحسب الكميات",
      }),
    });
  }
  if (useManual) {
    for (const l of outLines) {
      const pct = money(l.manualSharePct ?? "0");
      if (pct.lt(0) || pct.gt(100)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نسبة توزيع تكلفة غير صالحة",
            why: `نسبة توزيع كل مخرج يجب أن تكون بين 0% و100%، والقيمة المرسلة (${pct.toFixed(2)}%) خارج النطاق`,
            doThis: "أصلح النسبة إلى قيمة بين 0 و100، أو احذفها لاستعمال التوزيع التناسبي",
          }),
        });
      }
    }
    const sumPct = outLines.reduce((s, l) => s.plus(money(l.manualSharePct ?? "0")), new Decimal(0));
    if (sumPct.minus(100).abs().gt("0.01")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "مجموع نسب التوزيع لا يساوي 100%",
          why: `مجموع نسب المخرجات ${sumPct.toFixed(2)}% — لا 100% كما تشترط قسمة التكلفة الكاملة`,
          doThis: `عدّل النسب حتى يصير مجموعها 100%، أو احذفها كلّها لاستعمال التوزيع التناسبي`,
        }),
      });
    }
  }

  // اقفل صفوف رصيد المخرجات ثم اقرأ SUM العالمي **قبل** أي إدخال (مطابقة purchaseService).
  const outVarList = Array.from(new Set(outLines.map((l) => l.variantId)));
  await ensureBranchStockRows(tx, outVarList, branchId);
  const lockedStockRows = await tx
    .select({
      variantId: branchStock.variantId,
      branchId: branchStock.branchId,
      quantity: branchStock.quantity,
    })
    .from(branchStock)
    .where(inArray(branchStock.variantId, outVarList))
    .orderBy(asc(branchStock.variantId), asc(branchStock.branchId))
    .for("update");
  // اجمع نفس الصفوف التي قُرئت قراءةً قافلةً. SELECT SUM عادي بعد الانتظار قد
  // يرجع لقطة RR قديمة لا الرصيد الذي ثبّته القفل للتو.
  const stockMap = new Map<number, Decimal>();
  for (const row of lockedStockRows) {
    const variantId = Number(row.variantId);
    stockMap.set(
      variantId,
      (stockMap.get(variantId) ?? new Decimal(0)).plus(row.quantity ?? 0),
    );
  }
  const costMap = new Map(
    outVarList.map((variantId) => [
      variantId,
      lockedVariantCosts.get(variantId) ?? "0",
    ]),
  );

  let running = new Decimal(0);
  for (let j = 0; j < outLines.length; j++) {
    const l = outLines[j];
    let share: Decimal;
    if (j < outLines.length - 1) {
      share = useManual
        ? round2(allocPool.times(money(l.manualSharePct ?? "0")).div(100))
        : round2(allocPool.times(l.baseQuantity).div(totalOutBase));
      running = running.plus(share);
    } else {
      share = round2(allocPool.minus(running)); // آخر سطر يمتصّ بقايا التقريب
    }
    const allocatedCost = share;
    const costPerBase = round2(allocatedCost.div(l.baseQuantity));

    // WAVG على كلفة المخرَج: الرصيد العالمي القائم **قبل** هذا الإدخال.
    const existingQty = Decimal.max(stockMap.get(l.variantId) ?? new Decimal(0), 0);
    const oldCost = money(costMap.get(l.variantId) ?? "0");
    const recvQty = new Decimal(l.baseQuantity);
    const denom = existingQty.plus(recvQty);
    const newCost = denom.lte(0) || oldCost.lte(0)
      ? costPerBase
      : round2(existingQty.times(oldCost).plus(recvQty.times(costPerBase)).div(denom));

    await tx.insert(productionLines).values({
      productionOrderId,
      direction: "OUTPUT",
      variantId: l.variantId,
      productUnitId: l.productUnitId,
      quantity: l.quantity,
      baseQuantity: l.baseQuantity,
      unitCost: costPerBase.toFixed(2),
      lineCost: allocatedCost.toFixed(2),
      allocatedCost: allocatedCost.toFixed(2),
      manualSharePct: l.manualSharePct,
    });
    await applyMovement(tx, {
      variantId: l.variantId,
      branchId,
      baseQuantity: l.baseQuantity,
      movementType: "IN",
      referenceType: "PRODUCTION",
      referenceId: productionOrderId,
      createdBy: actor.userId,
    });
    await tx.update(productVariants).set({ costPrice: newCost.toFixed(2) }).where(eq(productVariants.id, l.variantId));

    // حدّث الخريطتين تسلسلياً للصنف المكرّر في نفس المستند.
    stockMap.set(l.variantId, denom);
    costMap.set(l.variantId, newCost.toFixed(2));
  }
}
