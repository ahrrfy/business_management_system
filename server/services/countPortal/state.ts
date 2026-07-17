// حالة بوابة العدّ (جرد أعمى).
// 🔒 يُمنع منعاً باتاً تضمين: expectedQty، الأسعار/التكاليف، كميات أو أسماء عدّات الزملاء.
import { asc, eq, inArray } from "drizzle-orm";
import {
  branches,
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
  stocktakeCounts,
  stocktakeItems,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import type { PortalIdentity } from "./identity";

export type PortalUnit = {
  unitName: string;
  /** عدد الوحدات الأساس في هذه الوحدة — معامل تحويل وليس مالاً (Number مشروع هنا). */
  factor: number;
  barcode: string | null;
  /** الباركودات البديلة للوحدة (`productUnitBarcodes`) — تُطابَق عند المسح كما في الكاشير. */
  aliases: string[];
};

export type PortalItem = {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  isMine: boolean;
  /** معدود من أي أحد (عدّ فعّال FIRST/RECOUNT) — بلا كمية لغير صاحب العدّ. */
  counted: boolean;
  /** آخر عدّة سجّلتُها أنا على هذا الصنف (إن وُجدت) — كميتي أراها وأعدّلها. */
  myCount: { qty: number; at: Date; unitBreakdown: string | null } | null;
  /** عدّه زميل (بلا كمية ولا اسم — جرد أعمى). */
  colleagueCounted: boolean;
  units: PortalUnit[];
};

/**
 * حالة بوابة العدّ (العقد §٥ — `state`).
 * 🔒 يُمنع منعاً باتاً تضمين: expectedQty، الأسعار/التكاليف، كميات أو أسماء عدّات الزملاء.
 */
export async function getPortalState(identity: PortalIdentity) {
  const db = requireDb();
  const { session, assignment } = identity;
  const myAssignmentId = Number(assignment.id);

  const branchRows = await db
    .select({ name: branches.name })
    .from(branches)
    .where(eq(branches.id, session.branchId))
    .limit(1);

  // أصناف الجلسة كلها (أصناف الزملاء تلزم للبحث/العدّ التحقّقي) — بلا expectedQty/unitCost.
  const itemRows = await db
    .select({
      variantId: stocktakeItems.variantId,
      assignmentId: stocktakeItems.assignmentId,
      recountStatus: stocktakeItems.recountStatus,
      recountReason: stocktakeItems.recountReason,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(stocktakeItems.sessionId, session.id))
    .orderBy(asc(stocktakeItems.id));

  const countRows = await db
    .select({
      id: stocktakeCounts.id,
      variantId: stocktakeCounts.variantId,
      assignmentId: stocktakeCounts.assignmentId,
      kind: stocktakeCounts.kind,
      qty: stocktakeCounts.qty,
      unitBreakdown: stocktakeCounts.unitBreakdown,
      countedAt: stocktakeCounts.countedAt,
    })
    .from(stocktakeCounts)
    .where(eq(stocktakeCounts.sessionId, session.id))
    .orderBy(asc(stocktakeCounts.id));

  const countsByVariant = new Map<number, typeof countRows>();
  for (const c of countRows) {
    const vid = Number(c.variantId);
    const arr = countsByVariant.get(vid);
    if (arr) arr.push(c);
    else countsByVariant.set(vid, [c]);
  }

  // وحدات القياس النشطة لكل متغيّر (قطعة/درزن/كرتون + باركود مستقل لكل وحدة).
  const variantIds = itemRows.map((r) => Number(r.variantId));
  const unitRows = variantIds.length
    ? await db
        .select({
          id: productUnits.id,
          variantId: productUnits.variantId,
          unitName: productUnits.unitName,
          conversionFactor: productUnits.conversionFactor,
          barcode: productUnits.barcode,
          isActive: productUnits.isActive,
        })
        .from(productUnits)
        .where(inArray(productUnits.variantId, variantIds))
        .orderBy(asc(productUnits.id))
    : [];
  const activeUnits = unitRows.filter((u) => u.isActive !== false);
  // الباركودات البديلة للوحدات النشطة — العدّاد يمسح أيّ باركود ملصوق على البضاعة (أساسيّاً أو بديلاً).
  const activeUnitIds = activeUnits.map((u) => Number(u.id));
  const aliasRows = activeUnitIds.length
    ? await db
        .select({ productUnitId: productUnitBarcodes.productUnitId, barcode: productUnitBarcodes.barcode })
        .from(productUnitBarcodes)
        .where(inArray(productUnitBarcodes.productUnitId, activeUnitIds))
        .orderBy(asc(productUnitBarcodes.id))
    : [];
  const aliasesByUnit = new Map<number, string[]>();
  for (const a of aliasRows) {
    const uid = Number(a.productUnitId);
    const arr = aliasesByUnit.get(uid) ?? [];
    arr.push(a.barcode);
    aliasesByUnit.set(uid, arr);
  }
  const unitsByVariant = new Map<number, PortalUnit[]>();
  for (const u of activeUnits) {
    const vid = Number(u.variantId);
    const arr = unitsByVariant.get(vid) ?? [];
    arr.push({
      unitName: u.unitName,
      factor: Number(u.conversionFactor),
      barcode: u.barcode ?? null,
      aliases: aliasesByUnit.get(Number(u.id)) ?? [],
    });
    unitsByVariant.set(vid, arr);
  }
  // الوحدات الكبرى أولاً (كرتون ثم درزن ثم قطعة) — كما في نموذج التصميم jrd-count.
  for (const arr of Array.from(unitsByVariant.values())) arr.sort((a, b) => b.factor - a.factor);

  let mineTotal = 0;
  let mineCounted = 0;
  let sessionCounted = 0;

  const items: PortalItem[] = itemRows.map((it) => {
    const vid = Number(it.variantId);
    const counts = countsByVariant.get(vid) ?? [];
    // «معدود» = يوجد عدّ فعّال (FIRST/RECOUNT) من أي أحد — VERIFY وحده لا يقع إلا بعد FIRST.
    const counted = counts.some((c) => c.kind === "FIRST" || c.kind === "RECOUNT");
    const isMine = Number(it.assignmentId) === myAssignmentId;
    const myCounts = counts.filter((c) => Number(c.assignmentId) === myAssignmentId);
    const myLast = myCounts.length ? myCounts[myCounts.length - 1] : null;
    const colleagueCounted = counts.some(
      (c) => (c.kind === "FIRST" || c.kind === "RECOUNT") && Number(c.assignmentId) !== myAssignmentId
    );
    if (counted) sessionCounted++;
    if (isMine) {
      mineTotal++;
      if (counted) mineCounted++;
    }
    return {
      variantId: vid,
      productName: it.productName,
      variantName: it.variantName,
      sku: it.sku,
      isMine,
      counted,
      myCount: myLast
        ? { qty: myLast.qty, at: myLast.countedAt, unitBreakdown: myLast.unitBreakdown ?? null }
        : null,
      colleagueCounted,
      units: unitsByVariant.get(vid) ?? [],
    };
  });
  // منطقتي أولاً ثم أصناف الزملاء (sort مستقر يحفظ ترتيب الإدراج داخل كل مجموعة).
  items.sort((a, b) => Number(b.isMine) - Number(a.isMine));

  // مهام إعادة العدّ المعلّقة على أصنافي — تظهر أعلى شاشة العامل.
  const recountTasks = itemRows
    .filter((it) => Number(it.assignmentId) === myAssignmentId && it.recountStatus === "PENDING")
    .map((it) => ({
      variantId: Number(it.variantId),
      productName: it.productName,
      variantName: it.variantName,
      reason: it.recountReason ?? "",
    }));

  return {
    session: {
      code: session.code,
      name: session.name,
      branchName: branchRows[0]?.name ?? "",
      status: session.status,
      dupPolicy: session.dupPolicy,
      blind: session.blind,
    },
    assignment: {
      id: myAssignmentId,
      name: assignment.name,
      zone: assignment.zone,
      status: assignment.status,
    },
    progress: {
      mine: { counted: mineCounted, total: mineTotal },
      session: { counted: sessionCounted, total: itemRows.length },
    },
    recountTasks,
    items,
  };
}
