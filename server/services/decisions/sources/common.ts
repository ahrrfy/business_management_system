/**
 * أدواتٌ مشتركة بين مصادر الصندوق: خرائط الأسماء، تسميات الأصناف، ومرآةُ فصل المهام.
 */
import { eq, inArray } from "drizzle-orm";
import type { DecisionFreshness, DecisionTrigger } from "@shared/decisionRegistry";
import {
  branches,
  customers,
  productUnits,
  productVariants,
  products,
  suppliers,
  users,
} from "../../../../drizzle/schema";
import { isRolloutOn } from "../../../config/rolloutFlags";
import { requireDb } from "../../tx";
import type { DecisionActor, DecisionScope } from "../types";

export type Db = ReturnType<typeof requireDb>;

/** معرّفاتٌ موجبةٌ فريدة من أيّ مزيج. */
export function ids(values: Array<number | string | null | undefined>): number[] {
  const out = new Set<number>();
  for (const v of values) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return Array.from(out);
}

export async function supplierNames(db: Db, supplierIds: number[]): Promise<Map<number, string>> {
  if (!supplierIds.length) return new Map();
  const rows = await db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(inArray(suppliers.id, supplierIds));
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

export async function customerNames(db: Db, customerIds: number[]): Promise<Map<number, string>> {
  if (!customerIds.length) return new Map();
  const rows = await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds));
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

export async function userNames(db: Db, userIds: number[]): Promise<Map<number, string>> {
  if (!userIds.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds));
  return new Map(rows.map((r) => [Number(r.id), r.name ?? ""]));
}

export async function branchNames(db: Db, branchIds: number[]): Promise<Map<number, string>> {
  if (!branchIds.length) return new Map();
  const rows = await db.select({ id: branches.id, name: branches.name }).from(branches).where(inArray(branches.id, branchIds));
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

export interface VariantLabel {
  productName: string;
  variantName: string | null;
  sku: string | null;
}

export async function variantLabels(db: Db, variantIds: number[]): Promise<Map<number, VariantLabel>> {
  if (!variantIds.length) return new Map();
  const rows = await db
    .select({
      id: productVariants.id,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
    })
    .from(productVariants)
    .leftJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));
  return new Map(
    rows.map((r) => [Number(r.id), { productName: r.productName ?? "", variantName: r.variantName ?? null, sku: r.sku ?? null }]),
  );
}

export async function unitNames(db: Db, unitIds: number[]): Promise<Map<number, string>> {
  if (!unitIds.length) return new Map();
  const rows = await db.select({ id: productUnits.id, unitName: productUnits.unitName }).from(productUnits).where(inArray(productUnits.id, unitIds));
  return new Map(rows.map((r) => [Number(r.id), r.unitName]));
}

/** الفروع التي يسرد عليها المصدر: العابرُ كلَّ الفروع النشطة، وغيرُه فرعَه وحده. */
export async function branchIdsFor(db: Db, actor: DecisionActor, scope: DecisionScope): Promise<number[]> {
  if (scope.branchIds) return scope.branchIds;
  if (!actor.crossBranch) return actor.branchId != null ? [actor.branchId] : [];
  const rows = await db.select({ id: branches.id }).from(branches).where(eq(branches.isActive, true));
  return rows.map((r) => Number(r.id));
}

export { serviceBranchScopedIds } from "./branchScope";

/**
 * فرعٌ واحد للمصادر التي تسرد بفرعٍ أو بلا فرع: مرشَّحُ الشاشة إن وُجد، وإلّا `null` للعابر
 * وفرعُ الفاعل لغيره. يُرجع `"NONE"` حين لا فرعَ للفاعل غير العابر — فيسرد المصدرُ لا شيء
 * بدل أن يفلتر على فرعٍ صفريّ كاذب.
 */
export function scopeBranch(actor: DecisionActor, scope: DecisionScope): number | null | "NONE" {
  if (scope.branchIds?.length) return scope.branchIds[0]!;
  if (actor.crossBranch) return null;
  return actor.branchId ?? "NONE";
}

/**
 * مرآةُ فصل المهام كما تنفّذه الخدمة الأصليّة — يُخفي الصفَّ الذي سيرفضه الخادم حتماً
 * («إظهارُ صفٍّ يُرفض قرارُه أسوأ من إخفائه»، `superAppRouter.approvalInbox`).
 *
 *  · `blocked`: المستخدمون الذين تمنعهم الخدمة (الطالب، منشئ المستند، آخر محرّر...).
 *  · `ownerExempt`: الخدمة تستثني المالك من الفصل (قرار المالك ٣/٩/٢٦ حيث طُبّق).
 *  · `trigger`: مع علَم `ownerOnlyApproval` مضاءً تُسقط `assertApprover` الفصلَ القديم على
 *    كلّ فعلٍ تصنيفُه `null` — فلا يُخفى الصفّ عندئذٍ. (العلَم مطفأٌ اليوم عمداً — راجع
 *    `shared/rolloutFlags.ts`.)
 */
export function sodHidden(args: {
  blocked: Array<number | null | undefined>;
  actor: DecisionActor;
  ownerExempt?: boolean;
  trigger?: DecisionTrigger | null;
  adminExempt?: boolean;
}): boolean {
  const { actor } = args;
  if (args.ownerExempt && actor.isOwner) return false;
  if (args.adminExempt && actor.role === "admin") return false;
  if (args.trigger === null && isRolloutOn("ownerOnlyApproval")) return false;
  return args.blocked.some((id) => id != null && Number(id) === actor.userId);
}

/** يحوّل قراءةَ حالةٍ إلى طزاجةٍ للصندوق. */
export async function freshnessFrom(read: () => Promise<string | null | undefined>, pending: readonly string[]): Promise<DecisionFreshness> {
  const status = await read();
  if (status == null) return "GONE";
  return pending.includes(status) ? "PENDING" : "DECIDED";
}
