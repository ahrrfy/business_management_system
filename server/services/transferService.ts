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
import { appErrorMessage } from "@shared/errors";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { branches, branchStock, inventoryMovements, productVariants, products, stockTransferLineBundleComponents, stockTransferLines, stockTransfers, suppliers, users } from "../../drizzle/schema";
import type { DB, Tx } from "../db";
import { getDb } from "../db";
import { applyMovement } from "./inventoryService";
import { lockEconomicInventoryScope, readEconomicVariant, changeEconomicTransit } from "./inventory/economicOwnership";
import { addBaseQuantityChecked } from "./inventory/transitProjection";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "./idempotency";
import { adjustSupplierBalance, postEntry } from "./ledgerService";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { money } from "./money";
import { nextCounterValue } from "./numbering";
import { extractInsertId } from "../lib/insertId";
import { classifyVariants, getBundleDefinitions, type BundleComponentRow } from "./bundleService";

export type TransferActor = { userId: number; role: string; branchId: number | null };

const COST_SNAPSHOT_RE = /\[COST_SNAPSHOT:([0-9]+(?:\.[0-9]{1,2})?)\]/;
const MAX_TRANSFER_PHYSICAL_VARIANTS = 200;
const MAX_TRANSFER_BUNDLE_SNAPSHOT_ROWS = 1_000;

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

type TransferQueryDb = DB | Tx;

interface TransferBundleSnapshot {
  id: number;
  componentVariantId: number;
  componentBaseQuantity: number;
}

function addBaseQuantity(target: Map<number, number>, variantId: number, baseQuantity: number): void {
  addBaseQuantityChecked(target, variantId, baseQuantity);
}

function bundleDefinitionsFingerprint(
  bundleVariantIds: number[],
  definitions: Map<number, BundleComponentRow[]>,
): string {
  return bundleVariantIds
    .slice()
    .sort((a, b) => a - b)
    .map((bundleVariantId) => {
      const components = (definitions.get(bundleVariantId) ?? [])
        .map((component) => `${component.componentVariantId}:${component.componentBaseQuantity}`)
        .sort();
      return `${bundleVariantId}=[${components.join(",")}]`;
    })
    .join("|");
}

async function loadTransferBundleSnapshots(
  db: TransferQueryDb,
  transferLineIds: number[],
): Promise<Map<number, TransferBundleSnapshot[]>> {
  const out = new Map<number, TransferBundleSnapshot[]>();
  const ids = Array.from(new Set(transferLineIds));
  if (!ids.length) return out;
  const rows = await db
    .select({
      id: stockTransferLineBundleComponents.id,
      transferLineId: stockTransferLineBundleComponents.transferLineId,
      componentVariantId: stockTransferLineBundleComponents.componentVariantId,
      componentBaseQuantity: stockTransferLineBundleComponents.componentBaseQuantity,
    })
    .from(stockTransferLineBundleComponents)
    .where(inArray(stockTransferLineBundleComponents.transferLineId, ids));
  for (const row of rows) {
    const lineId = Number(row.transferLineId);
    const components = out.get(lineId) ?? [];
    components.push({
      id: Number(row.id),
      componentVariantId: Number(row.componentVariantId),
      componentBaseQuantity: Number(row.componentBaseQuantity),
    });
    out.set(lineId, components);
  }
  Array.from(out.values()).forEach((components: TransferBundleSnapshot[]) => {
    components.sort((a: TransferBundleSnapshot, b: TransferBundleSnapshot) =>
      a.componentVariantId - b.componentVariantId,
    );
  });
  return out;
}

type SavedTransferEvidence = {
  lines: Array<typeof stockTransferLines.$inferSelect>;
  snapshots: Map<number, TransferBundleSnapshot[]>;
  movements: Array<typeof inventoryMovements.$inferSelect>;
};
async function readTransferEvidence(tx: Tx, transferId: number, known?: SavedTransferEvidence) {
  const query = tx.select().from(stockTransfers).where(eq(stockTransfers.id, transferId));
  const [doc] = known ? await query.for("update") : await query;
  if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "سند التحويل غير موجود" });
  let lines: SavedTransferEvidence["lines"] = [];
  let movements: SavedTransferEvidence["movements"] = [];
  let snapshots = new Map<number, TransferBundleSnapshot[]>();
  if (known) {
    // Existing saved closure is immutable in application code. Re-read existing PKs,
    // never nonunique transfer/ref ranges whose next-key gaps block unrelated first inserts.
    for (const old of known.lines) {
      const [row] = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.id, old.id)).for("share");
      if (row) lines.push(row);
    }
    for (const [lineId, components] of Array.from(known.snapshots)) {
      const values: TransferBundleSnapshot[] = [];
      for (const old of components) {
        const [row] = await tx.select().from(stockTransferLineBundleComponents).where(eq(stockTransferLineBundleComponents.id, old.id)).for("share");
        if (row && row.transferLineId === lineId) values.push({ id: row.id, componentVariantId: row.componentVariantId, componentBaseQuantity: row.componentBaseQuantity });
      }
      if (values.length) snapshots.set(lineId, values);
    }
    for (const old of known.movements) {
      const [row] = await tx.select().from(inventoryMovements).where(eq(inventoryMovements.id, old.id)).for("share");
      if (row) movements.push(row);
    }
  } else {
    lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, transferId)).orderBy(asc(stockTransferLines.id));
    snapshots = await loadTransferBundleSnapshots(tx, lines.map(line => line.id));
    movements = await tx.select().from(inventoryMovements).where(and(eq(inventoryMovements.referenceType, "TRANSFER"), eq(inventoryMovements.referenceId, transferId), eq(inventoryMovements.movementType, "TRANSFER_OUT"))).orderBy(asc(inventoryMovements.id));
  }
  const fingerprint = JSON.stringify({ from: doc.fromBranchId, to: doc.toBranchId, total: doc.totalSentBase, lines, snapshots: Array.from(snapshots), movements });
  const ids = lines.flatMap(line => [line.variantId, ...(snapshots.get(line.id) ?? []).map(c => c.componentVariantId)]).concat(movements.map(m => m.variantId));
  return { doc, lines, snapshots, movements, fingerprint, ids };
}

/** Discover immutable closure first; only then lock mutable document and revalidate current evidence. */
async function lockTransferSettlementScope(tx: Tx, transferId: number) {
  const discovered = await readTransferEvidence(tx, transferId);
  const scope = await lockEconomicInventoryScope(tx, discovered.ids);
  const current = await readTransferEvidence(tx, transferId, discovered);
  if (discovered.fingerprint !== current.fingerprint)
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تغيّر سند التحويل أثناء تثبيت المخزون",
        why: "اختلفت هوية السند أو أسطره أو بينة الإرسال أثناء انتظار الأقفال",
        doThis: "أعد تحميل السند ثم أعد المحاولة",
      }),
    });
  const sent = new Map<number, number>();
  if (current.doc.status !== "IN_TRANSIT") return { ...current, scope, sent };
  const actual = new Map<number, number>();
  for (const line of current.lines) {
    const row = await readEconomicVariant(tx, scope, line.variantId);
    if (
      (row.product.isBundle && !current.snapshots.get(line.id)?.length) ||
      line.quantityReceived !== null ||
      line.quantitySent <= 0
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر تسوية سند التحويل",
          why: "لقطة مكوّنات البكج أو كمية الإرسال غير مكتملة أو استلام سابق غير محسوم",
          doThis:
            "أوقف العملية وراجع بينة الإرسال؛ لا يمكن تخمين الكمية التاريخية",
        }),
      });
    for (const movement of expandTransferLine(
      line,
      line.quantitySent,
      current.snapshots,
    ))
      addBaseQuantity(sent, movement.variantId, movement.baseQuantity);
  }
  for (const move of current.movements) {
    if (
      move.branchId !== current.doc.fromBranchId ||
      move.relatedBranchId !== current.doc.toBranchId ||
      move.quantity <= 0 ||
      (move.signedDelta !== null && move.signedDelta !== -move.quantity)
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({ what: "تعذّر إثبات إرسال التحويل", why: "حركة الإرسال غير متطابقة مع مصدر السند ووجهته", doThis: "أوقف التسوية وراجع السند وبينة المخزون قبل إعادة المحاولة" }),
      });
    addBaseQuantity(actual, move.variantId, move.quantity);
  }
  const sorted = (map: Map<number, number>) =>
    JSON.stringify(Array.from(map).sort(([a], [b]) => a - b));
  if (
    !sent.size ||
    sorted(sent) !== sorted(actual) ||
    current.lines.reduce((sum, line) => sum + line.quantitySent, 0) !==
      current.doc.totalSentBase
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تسوية سند التحويل",
        why: "لا تطابق مكوّنات السند المحفوظة حركات الإرسال الفعلية",
        doThis: "أوقف العملية وراجع السند وبينة المخزون دون إنشاء تاريخ بديل",
      }),
    });
  return { ...current, scope, sent };
}

function expandTransferLine(
  line: { id: number; variantId: number; quantitySent: number },
  operationalQuantity: number,
  snapshots: Map<number, TransferBundleSnapshot[]>,
): Array<{ variantId: number; baseQuantity: number }> {
  const components = snapshots.get(Number(line.id));
  if (!components?.length) {
    return [{ variantId: Number(line.variantId), baseQuantity: operationalQuantity }];
  }
  return components.map((component) => ({
    variantId: component.componentVariantId,
    baseQuantity: component.componentBaseQuantity * operationalQuantity,
  }));
}

/**
 * إنشاء سند تحويل + خصم المصدر (TRANSFER_OUT لكل صنف مخزني فعلي) داخل معاملة واحدة — إمّا يخرج السند
 * كاملاً «بالطريق» أو لا شيء (نقص مخزون بأي سطر = ROLLBACK للكل).
 */
/**
 * قفل أرصدة أصناف السند **في فرعَي التحويل وحدهما**، مرتَّباً تصاعدياً بالمتغيّر.
 *
 * المسار هـ-٢ (١٧/٨) — نظير هـ-١ في مسار الهدايا: كان القفل `WHERE variantId IN (…)` **بلا شرط
 * فرع** ⇒ يقفل صفوف **كلّ الفروع** لتلك الأصناف، فتُسلسَل مبيعات فرعٍ ثالثٍ لا علاقة له بالتحويل
 * خلفه (اختناقٌ صامت لا خطأ يظهر). ولا يشتري ذلك أمانَ WAVG: لقطة التكلفة تُقرأ من
 * `productVariants.costPrice` (عالميّة) وتُقفَل بصفّها مباشرةً بعد هذا القفل — وكمّيات الفروع
 * الأخرى لا تدخل حساب هذا السند إطلاقاً.
 *
 * الترتيب التصاعديّ يبقى إلزامياً (لا يُمَسّ): هو ما يمنع `ER_LOCK_DEADLOCK` بين سندين
 * متزامنين يمسكان الأصناف نفسها؛ mutex المتغيّر يُؤخذ قبل هذا القفل في كل مستدعٍ.
 */
async function lockTransferBranchStock(
  tx: Tx,
  sortedVariantIds: number[],
  branchIds: number[],
): Promise<void> {
  if (!sortedVariantIds.length) return;
  await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(
      and(
        inArray(branchStock.variantId, sortedVariantIds),
        inArray(branchStock.branchId, Array.from(new Set(branchIds)).sort((x, y) => x - y)),
      ),
    )
    .orderBy(asc(branchStock.variantId))
    .for("update");
}

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

  // البكج يبقى سطراً تشغيلياً واحداً في السند، لكن الرصيد الفعلي لمكوّناته. نقرأ الوصفة أولاً
  // لبناء إغلاق المتغيّرات دفعةً واحدة، ثم نعيد قراءتها بعد القفل. إن تغيّرت في نافذة السباق
  // نرفض المعاملة كلّها؛ بذلك لا نمزج وصفةً قديمة بمكوّناتٍ جديدة ولا نعكس ترتيب الأقفال.
  const sorted = [...a.items].sort((x, y) => x.variantId - y.variantId);
  const sortedVariantIds = sorted.map((it) => it.variantId);
  const provisionalKinds = await classifyVariants(tx, sortedVariantIds);
  const unknownVariantId = sortedVariantIds.find((variantId) => !provisionalKinds.has(variantId));
  if (unknownVariantId != null) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: `تعذّر إضافة الصنف #${unknownVariantId} إلى سند التحويل`,
        why: "الصنف غير موجود في الكتالوج الحالي",
        doThis: "أعد تحميل شاشة التحويل واختر الصنف من نتائج البحث الحالية",
      }),
    });
  }
  const serviceVariantId = sortedVariantIds.find((variantId) => provisionalKinds.get(variantId) === "SERVICE");
  if (serviceVariantId != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّر نقل الصنف الخدمي #${serviceVariantId}`,
        why: "الخدمة بلا رصيد مخزني فعلي يمكن تحويله بين الفروع",
        doThis: "احذف الخدمة من السند وانقل موادها المخزنية عند الحاجة",
      }),
    });
  }
  const provisionalBundleIds = sortedVariantIds.filter(
    (variantId) => provisionalKinds.get(variantId) === "BUNDLE",
  );
  const provisionalDefinitions = await getBundleDefinitions(tx, provisionalBundleIds);
  for (const bundleVariantId of provisionalBundleIds) {
    if (!provisionalDefinitions.get(bundleVariantId)?.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر نقل البكج #${bundleVariantId}`,
          why: "وصفة البكج لا تحتوي مكوّنات مخزنية",
          doThis: "أكمل وصفة البكج من شاشة المنتجات ثم أعد إنشاء السند",
        }),
      });
    }
  }
  const provisionalFingerprint = bundleDefinitionsFingerprint(
    provisionalBundleIds,
    provisionalDefinitions,
  );
  const provisionalComponentIds = Array.from(provisionalDefinitions.values())
    .flatMap((components) => components.map((component) => component.componentVariantId));
  const economicScope = await lockEconomicInventoryScope(tx, sortedVariantIds.concat(provisionalComponentIds));

  const lockedKinds = new Map<number, "BUNDLE" | "SERVICE" | "STOCKED">();
  for (const id of sortedVariantIds) {
    const row = await readEconomicVariant(tx, economicScope, id);
    lockedKinds.set(id, row.product.isBundle ? "BUNDLE" : row.product.isService ? "SERVICE" : "STOCKED");
  }
  const lockedBundleIds = sortedVariantIds.filter(
    (variantId) => lockedKinds.get(variantId) === "BUNDLE",
  );
  const lockedDefinitions = await getBundleDefinitions(tx, lockedBundleIds, { lock: true });
  if (
    lockedBundleIds.join(",") !== provisionalBundleIds.join(",") ||
    bundleDefinitionsFingerprint(lockedBundleIds, lockedDefinitions) !== provisionalFingerprint
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "توقّف إنشاء سند التحويل",
        why: "تغيّرت وصفة أحد البكجات أثناء إعداد السند",
        doThis: "أعد الإرسال لتُلتقط الوصفة الحالية كاملة",
      }),
    });
  }

  const bundleComponentIds = Array.from(lockedDefinitions.values())
    .flatMap((components) => components.map((component) => component.componentVariantId));
  if (bundleComponentIds.length) {
    const byId = new Map<number, { variantActive: boolean | null; productActive: boolean | null; productName: string; sku: string }>();
    for (const id of Array.from(new Set(bundleComponentIds))) {
      const row = await readEconomicVariant(tx, economicScope, id);
      if (row.product.isBundle || row.product.isService) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تغيّر تصنيف مكوّن البكج", why: "المكوّن لم يعد مخزوناً فعلياً ضمن النطاق المثبت", doThis: "أعد تحميل السند والوصفة ثم أعد المحاولة" }) });
      byId.set(id, { variantActive: row.isActive, productActive: row.product.isActive, productName: row.product.name, sku: row.sku });
    }
    for (const componentVariantId of Array.from(new Set(bundleComponentIds))) {
      const row = byId.get(componentVariantId);
      if (!row || row.variantActive === false || row.productActive === false) {
        const label = row ? `«${row.productName} — ${row.sku}»` : `#${componentVariantId}`;
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: `تعذّر نقل مكوّن البكج ${label}`,
            why: "المكوّن معطّل أو غير موجود في الكتالوج الحالي",
            doThis: "فعّل المكوّن أو استبدله في وصفة البكج ثم أعد إنشاء السند",
          }),
        });
      }
    }
  }

  const movementTotals = new Map<number, number>();
  for (const item of sorted) {
    if (lockedKinds.get(item.variantId) === "BUNDLE") {
      for (const component of lockedDefinitions.get(item.variantId) ?? []) {
        addBaseQuantity(
          movementTotals,
          component.componentVariantId,
          component.componentBaseQuantity * item.baseQuantity,
        );
      }
    } else {
      addBaseQuantity(movementTotals, item.variantId, item.baseQuantity);
    }
  }
  const movementVariantIds = Array.from(movementTotals.keys()).sort((a, b) => a - b);
  const bundleSnapshotRowCount = lockedBundleIds.reduce(
    (total, bundleVariantId) => total + (lockedDefinitions.get(bundleVariantId)?.length ?? 0),
    0,
  );
  if (
    movementVariantIds.length > MAX_TRANSFER_PHYSICAL_VARIANTS ||
    bundleSnapshotRowCount > MAX_TRANSFER_BUNDLE_SNAPSHOT_ROWS
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "سند التحويل أكبر من الحد التشغيلي الآمن",
        why: `يتوسع السند إلى ${movementVariantIds.length} صنفاً مخزنياً و${bundleSnapshotRowCount} سطر مكوّن بكج`,
        doThis: "قسّم الأصناف على أكثر من سند ثم أرسلها بالتتابع",
      }),
    });
  }
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const seq = await nextCounterValue(tx, `stock_transfer_${yymm}`);
  const transferNumber = `TRF-${yymm}-${seq}`;
  const totalSentBase = a.items.reduce((s, it) => s + it.baseQuantity, 0);
  const res = await tx.insert(stockTransfers).values({
    transferNumber,
    fromBranchId: a.fromBranchId,
    toBranchId: a.toBranchId,
    reason: a.reason ?? null,
    notes: a.notes?.trim() || null,
    totalSentBase,
    createdBy: a.createdBy,
  });
  const transferId = extractInsertId(res);

  // نفس ترتيب أقفال WAVG في الشراء/الإنتاج: mutex الصنف ثم أرصدة الفروع.
  // بذلك تكون لقطة الإرسال هي التكلفة الفعلية لحظة خروج البضاعة، لا قراءة سبقت استلاماً متزامناً.
  await lockTransferBranchStock(tx, movementVariantIds, [a.fromBranchId, a.toBranchId]);
  const costRows = await tx
    .select({ id: productVariants.id, costPrice: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, movementVariantIds))
    .orderBy(asc(productVariants.id))
    .for("update");
  const costAtDispatch = new Map(costRows.map((row) => [Number(row.id), money(row.costPrice ?? "0").toFixed(2)]));
  await tx.insert(stockTransferLines).values(
    sorted.map((it) => ({
      transferId,
      variantId: it.variantId,
      quantitySent: it.baseQuantity,
    })),
  );
  const persistedLines = await tx
    .select({ id: stockTransferLines.id, variantId: stockTransferLines.variantId })
    .from(stockTransferLines)
    .where(eq(stockTransferLines.transferId, transferId));
  if (persistedLines.length !== sorted.length) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تثبيت جميع أسطر سند التحويل" });
  }
  const transferLineIdByVariant = new Map(
    persistedLines.map((line) => [Number(line.variantId), Number(line.id)]),
  );
  const bundleSnapshotValues: Array<typeof stockTransferLineBundleComponents.$inferInsert> = [];
  for (const it of sorted) {
    if (lockedKinds.get(it.variantId) === "BUNDLE") {
      const transferLineId = transferLineIdByVariant.get(it.variantId);
      if (transferLineId == null) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `تعذّر ربط سطر البكج #${it.variantId}` });
      }
      for (const component of lockedDefinitions.get(it.variantId) ?? []) {
        bundleSnapshotValues.push({
          transferLineId,
          componentVariantId: component.componentVariantId,
          componentBaseQuantity: component.componentBaseQuantity,
        });
      }
    }
  }
  if (bundleSnapshotValues.length) {
    await tx.insert(stockTransferLineBundleComponents).values(bundleSnapshotValues);
  }
  await changeEconomicTransit(tx, economicScope, a.fromBranchId, movementTotals, 1);
  for (const variantId of movementVariantIds) {
    const costSnapshot = costAtDispatch.get(variantId);
    if (costSnapshot == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: `الصنف #${variantId} غير موجود` });
    }
    await applyMovement(tx, {
      variantId,
      branchId: a.fromBranchId,
      baseQuantity: movementTotals.get(variantId)!,
      movementType: "TRANSFER_OUT",
      relatedBranchId: a.toBranchId,
      referenceType: "TRANSFER",
      referenceId: transferId,
      documentNumber: transferNumber,
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
    // ⭐ replay = العملية مُستهلَكةٌ سابقاً؛ الأثر محفوظ على السند. أعِد الفرقَ الحقيقيّ من الوثيقة بدل
    // صفرٍ ثابت كان يُخفي عجزَ السند الأصليّ عن العميل الذي يعيد المحاولة (اقتراح تقرير المراجعة P2-#2،
    // ٢٥/٨). المسار الأصليّ يحسبه فرقَ الإرسال ناقص المستلَم في نفس الفرع المستلِم — نقرأ اللقطة نفسها.
    const replayDoc = (
      await tx
        .select({ totalSentBase: stockTransfers.totalSentBase, totalReceivedBase: stockTransfers.totalReceivedBase })
        .from(stockTransfers)
        .where(eq(stockTransfers.id, a.transferId))
        .limit(1)
    )[0];
    const replayDiscrepancy = replayDoc
      ? Number(replayDoc.totalSentBase) - Number(replayDoc.totalReceivedBase ?? 0)
      : 0;
    return {
      transferId: a.transferId,
      idempotentReplay: true as const,
      discrepancyUnits: replayDiscrepancy,
    };
  }

  const settlement = await lockTransferSettlementScope(tx, a.transferId);
  const { doc, lines: docLines, snapshots: bundleSnapshots, scope: economicScope } = settlement;
  assertBranchActor(a.actor, Number(doc.toBranchId), "استلام التحويل حصريّ لموظفي الفرع الوجهة");
  if (doc.status !== "IN_TRANSIT") throw new TRPCError({ code: "CONFLICT", message: `السند ${doc.transferNumber} ليس بالطريق (حالته الحالية لا تقبل الاستلام)` });
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

  // السطر يبقى بوحدته التشغيلية (البكج = 1)، بينما الأثر المخزني يتوسع من لقطة الإرسال.
  let totalReceivedBase = 0;
  const receivedByVariant = new Map<number, number>();
  const shortageByVariant = new Map<number, number>();
  for (const l of a.lines) {
    const dl = byId.get(l.lineId)!;
    totalReceivedBase += l.quantityReceived;
    if (l.quantityReceived < dl.quantitySent) {
      for (const movement of expandTransferLine(
        dl,
        dl.quantitySent - l.quantityReceived,
        bundleSnapshots,
      )) {
        addBaseQuantity(shortageByVariant, movement.variantId, movement.baseQuantity);
      }
    }
    if (l.quantityReceived > 0) {
      for (const movement of expandTransferLine(dl, l.quantityReceived, bundleSnapshots)) {
        addBaseQuantity(receivedByVariant, movement.variantId, movement.baseQuantity);
      }
    }
    await tx
      .update(stockTransferLines)
      .set({ quantityReceived: l.quantityReceived, note: l.note?.trim() || null })
      .where(eq(stockTransferLines.id, l.lineId));
  }

  const operationalDiscrepancy = Number(doc.totalSentBase) - totalReceivedBase;
  for (const variantId of Array.from(receivedByVariant.keys()).sort((a, b) => a - b)) {
    await applyMovement(tx, {
      variantId,
      branchId: Number(doc.toBranchId),
      baseQuantity: receivedByVariant.get(variantId)!,
      movementType: "TRANSFER_IN",
      relatedBranchId: Number(doc.fromBranchId),
      referenceType: "TRANSFER",
      referenceId: a.transferId,
      documentNumber: doc.transferNumber,
      notes:
        operationalDiscrepancy === 0
          ? `استلام سند ${doc.transferNumber} — مطابق`
          : `استلام سند ${doc.transferNumber} — مع فروقات موثّقة على أسطر السند`,
      createdBy: a.actor.userId,
    });
  }
  const shortages = Array.from(shortageByVariant.entries())
    .map(([variantId, qty]) => ({ variantId, qty }))
    .sort((a, b) => a.variantId - b.variantId);

  // قيد خسارة نقل بقيمة التكلفة (قرار مالك ١٤/٧): العجز خرج من رصيد المصدر ولم يصل الوجهة ⇒
  // مصروف حقيقي في P&L (نمط قيد تسوية الجرد: cost موجب/profit سالب، بلا نقد). يُنسب لفرع
  // **المصدر** — البضاعة كانت في عهدته حتى تسليمها، وعنده يبدأ تحقيق العجز. dedupeKey يمنع الازدواج.
  if (shortages.length) {
    const ids = shortages.map((s) => s.variantId);
    const dispatchMoves = settlement.movements;
    const costOf = new Map<number, string>();
    for (const move of dispatchMoves) {
      const snapshot = transferCostSnapshot(move.notes);
      if (snapshot != null) costOf.set(Number(move.variantId), snapshot);
    }
    // Owned shortage leaves the asset at current carrying cost; consignment retains saved dispatch share.
    const ownershipByVariant = new Map<number, { isConsignment: boolean | null; consignorId: number | null; currentCost: string }>();
    for (const id of ids) {
      const row = await readEconomicVariant(tx, economicScope, id);
      ownershipByVariant.set(id, { isConsignment: row.product.isConsignment, consignorId: row.product.consignorId, currentCost: row.costPrice });
    }
    let ownedLossValue = money(0);
    const consignmentLossByConsignor = new Map<number, ReturnType<typeof money>>();
    for (const shortage of shortages) {
      const ownership = ownershipByVariant.get(shortage.variantId);
      if (!ownership) {
        throw new TRPCError({ code: "NOT_FOUND", message: `الصنف #${shortage.variantId} غير موجود` });
      }
      if (ownership.isConsignment && !costOf.has(shortage.variantId)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: `تعذّر تقييم عجز الأمانة #${shortage.variantId}`, why: "سند الإرسال لا يحتوي لقطة حصة المودع الموثقة", doThis: "أوقف التسوية وراجع بينة الإرسال دون تخمين الحصة التاريخية" }) });
      const value = money(ownership.isConsignment ? costOf.get(shortage.variantId)! : ownership.currentCost).times(shortage.qty);
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

  await changeEconomicTransit(tx, economicScope, Number(doc.fromBranchId), settlement.sent, -1);
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
  const settlement = await lockTransferSettlementScope(tx, a.transferId);
  const { doc, scope: economicScope, sent: restoreByVariant } = settlement;
  assertBranchActor(a.actor, Number(doc.fromBranchId), "إلغاء التحويل حصريّ لموظفي الفرع المرسل");
  if (doc.status !== "IN_TRANSIT") throw new TRPCError({ code: "CONFLICT", message: "لا يُلغى إلا سندٌ ما يزال بالطريق" });
  await changeEconomicTransit(tx, economicScope, Number(doc.fromBranchId), restoreByVariant, -1);
  for (const variantId of Array.from(restoreByVariant.keys()).sort((a, b) => a - b)) {
    await applyMovement(tx, {
      variantId,
      branchId: Number(doc.fromBranchId),
      baseQuantity: restoreByVariant.get(variantId)!,
      movementType: "TRANSFER_IN",
      relatedBranchId: Number(doc.toBranchId),
      referenceType: "TRANSFER",
      referenceId: a.transferId,
      documentNumber: doc.transferNumber,
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
  /** الأدمن فقط: حصر بفرع معيّن (وإلا كل الفروع). غير المرفوعين يُجبَرون على فرعهم. */
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

  const rawLines = await db
    .select({
      id: stockTransferLines.id,
      variantId: stockTransferLines.variantId,
      quantitySent: stockTransferLines.quantitySent,
      quantityReceived: stockTransferLines.quantityReceived,
      note: stockTransferLines.note,
      productName: products.name,
      variantName: productVariants.variantName,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      size: productVariants.size,
      variantKind: productVariants.variantKind,
      sku: productVariants.sku,
      isBundle: products.isBundle,
    })
    .from(stockTransferLines)
    .innerJoin(productVariants, eq(productVariants.id, stockTransferLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(stockTransferLines.transferId, transferId))
    .orderBy(stockTransferLines.id);

  const componentRows = rawLines.length
    ? await db
        .select({
          transferLineId: stockTransferLineBundleComponents.transferLineId,
          variantId: stockTransferLineBundleComponents.componentVariantId,
          baseQuantityPerBundle: stockTransferLineBundleComponents.componentBaseQuantity,
          productName: products.name,
          variantName: productVariants.variantName,
          color: productVariants.color,
          colorHex: productVariants.colorHex,
          size: productVariants.size,
          variantKind: productVariants.variantKind,
          sku: productVariants.sku,
        })
        .from(stockTransferLineBundleComponents)
        .innerJoin(
          productVariants,
          eq(productVariants.id, stockTransferLineBundleComponents.componentVariantId),
        )
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          inArray(
            stockTransferLineBundleComponents.transferLineId,
            rawLines.map((line) => Number(line.id)),
          ),
        )
        .orderBy(
          stockTransferLineBundleComponents.transferLineId,
          stockTransferLineBundleComponents.componentVariantId,
        )
    : [];
  const componentsByLine = new Map<
    number,
    Array<{
      variantId: number;
      baseQuantityPerBundle: number;
      productName: string;
      variantName: string | null;
      sku: string;
    }>
  >();
  for (const component of componentRows) {
    const lineId = Number(component.transferLineId);
    const list = componentsByLine.get(lineId) ?? [];
    list.push({
      variantId: Number(component.variantId),
      baseQuantityPerBundle: Number(component.baseQuantityPerBundle),
      productName: component.productName,
      variantName: component.variantName,
      sku: component.sku,
    });
    componentsByLine.set(lineId, list);
  }
  const lines = rawLines.map((line) => {
    const bundleComponents = componentsByLine.get(Number(line.id)) ?? [];
    const isBundle = bundleComponents.length > 0 || line.isBundle === true;
    return {
      ...line,
      isBundle,
      unitLabel: isBundle ? "بكج" as const : "وحدة أساس" as const,
      bundleComponents,
    };
  });

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

/** عدد السندات الواردة «بالطريق» — شارة «بانتظار الاستلام». null = كل الفروع (أدمن). */
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
