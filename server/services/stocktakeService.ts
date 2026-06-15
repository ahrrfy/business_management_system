// خدمة الجرد والتسوية (Stocktake) — كل منطق الأعمال وفق عقد docs/stocktake-contract.md.
//
// الدورة: إنشاء جلسة (لقطة دفترية ذرّية) → عدّ أعمى عبر البوابة → مراجعة (فروقات/تعارض/
// إعادة عدّ/قرارات) → اعتماد ذرّي (setStock بمرجع STOCKTAKE + قيد دفتري بـ dedupeKey) →
// تقرير/محضر + ذكاء تشغيلي (ABC دوري + IRA).
//
// اتفاقيات حاكمة (§٥ من CLAUDE.md):
//   - كل عملية كتابة داخل withTx — أي throw ⇒ ROLLBACK كامل.
//   - تغيير المخزون حصراً عبر inventoryService (التسوية عبر setStock فقط).
//   - الأموال decimal.js عبر money.ts — ممنوع parseFloat/Number على الأموال.
//   - بوابة العدّ لا تستلم expectedQty/أسعاراً أبداً (الجرد الأعمى).
import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { randomBytes, randomInt } from "node:crypto";
import { mysqlCodeFrom } from "../../shared/errorMap.ar";
import { and, asc, desc, eq, gt, gte, inArray, like, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  branches,
  branchStock,
  categories,
  inventoryMovements,
  productUnits,
  productVariants,
  products,
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../drizzle/schema";
import type { DB, Tx } from "../db";
import { hashPassword, verifyPassword } from "../auth/password";
import { setStock } from "./inventoryService";
import { postEntry } from "./ledgerService";
import { money, toDbMoney } from "./money";
import { requireDb, withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";

/** قراءة تعمل على القاعدة أو داخل معاملة (الاعتماد يعيد الحساب داخل tx). */
type DbLike = DB | Tx;

export type StkActor = { userId: number };

/* ============================ ثوابت وأدوات ============================ */

const SCOPE_FALLBACK_LABEL: Record<string, string> = {
  FULL: "جرد شامل للفرع",
  MOVING: "الأصناف المتحركة",
  CATEGORY: "حسب الفئة",
  MANUAL: "أصناف مختارة",
};

/** تسمية عربية لنوع حركة المخزون (لعرض «حركة بعد العدّ»). */
const MOVE_LABEL: Record<string, string> = {
  IN: "إدخال",
  OUT: "إخراج",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
  ADJUST: "تسوية",
};

/** دوريّات الجرد الدوري ABC (README §٧). */
const ABC_FREQ_DAYS = { A: 30, B: 90, C: 180 } as const;
const ABC_FREQ_LABEL = { A: "شهرياً", B: "فصلياً", C: "نصف سنوياً" } as const;

function chunk<T>(arr: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function scopeLabelOf(scopeType: string, scopeDetail: string | null): string {
  try {
    const d = JSON.parse(scopeDetail ?? "");
    if (d && typeof d.label === "string" && d.label) return d.label;
  } catch {
    /* تفاصيل قديمة/فارغة ⇒ التسمية الافتراضية */
  }
  return SCOPE_FALLBACK_LABEL[scopeType] ?? scopeType;
}

/**
 * إشارة حركة ADJUST: setStock يخزّن |الدلتا| في quantity والاتجاه في النص الافتراضي
 * «تسوية: من X إلى Y (فرق ±D)». نعيد بناء الدلتا الموقَّعة من النص إن طابق النمط؛
 * وإلا (ملاحظة مخصّصة من شاشة المخزون) نعيد null — تُعرض الحركة بكمية 0 ولا تدخل netAfter
 * (تسوية يدوية أثناء الجرد حالة نادرة؛ التشويه الصامت أسوأ من التجاهل المُعلَم).
 */
function adjustSignedDelta(notes: string | null): number | null {
  if (!notes) return null;
  const m = notes.match(/فرق\s*([+\-−]?)\s*(\d+)/);
  if (!m) return null;
  const sign = m[1] === "-" || m[1] === "−" ? -1 : 1;
  return sign * parseInt(m[2], 10);
}

/** الكمية الموقَّعة لحركة مخزون — تطابق إشارات inventoryService (IN/RETURN/TRANSFER_IN=+، OUT/TRANSFER_OUT=−). */
function signedMoveQty(movementType: string, quantity: number, notes: string | null): number {
  switch (movementType) {
    case "IN":
    case "RETURN":
    case "TRANSFER_IN":
      return quantity;
    case "OUT":
    case "TRANSFER_OUT":
      return -quantity;
    case "ADJUST":
      return adjustSignedDelta(notes) ?? 0;
    default:
      return 0;
  }
}

/** PIN رباعي عشوائي مشفّر التوليد (crypto) فريد ضمن المجموعة المُمرَّرة. */
function generateUniquePin(used: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const pin = String(randomInt(0, 10000)).padStart(4, "0");
    if (!used.has(pin)) {
      used.add(pin);
      return pin;
    }
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر توليد رمز PIN فريد" });
}

/* ============================ توليد رمز الجلسة ============================ */

/**
 * CNT-<السنة>-<NNNN>-<RAND4> — تسلسلي مع لاحقة عشوائية تمنع تخمين الرمز.
 * كان الرمز تسلسلياً بحتاً (CNT-2026-0001 …) ⇒ يخمّنه مهاجم خارجي بسهولة، وبما أنّ count.auth
 * publicProcedure والنظام على الإنترنت، كان يكفي تخمين الرمز ليُحاول PINات على رابط جلسة فعلية.
 * اللاحقة العشوائية (٤ خانات base36 من crypto.randomBytes) تضيف ~٢٠ بت من المفاجأة فيستحيل التخمين.
 * مع إبقاء البادئة التسلسلية NNNN لسهولة القراءة البشرية والترتيب.
 * قيد UNIQUE على code هو الحارس النهائي للسباق.
 */
async function nextSessionCode(tx: Tx): Promise<string> {
  const prefix = `CNT-${new Date().getFullYear()}-`;
  const rows = await tx
    .select({ code: stocktakeSessions.code })
    .from(stocktakeSessions)
    .where(like(stocktakeSessions.code, `${prefix}%`))
    .orderBy(desc(stocktakeSessions.code))
    .for("update")
    .limit(1);
  const last = rows[0]?.code;
  // البادئة العددية الجارية: نقتطع أول ٤ أرقام بعد البادئة (LIKE قد يلتقط رموزاً قديمة بلا لاحقة).
  const lastSeq = last ? parseInt(last.slice(prefix.length, prefix.length + 4), 10) : NaN;
  const seq = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;
  // ٤ أحرف base36 من ٣ بايتات عشوائية ⇒ ~٢٠ بت من العشوائية، بلا اعتماد على Math.random.
  const rand4 = randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, "0").slice(-4).toUpperCase();
  return prefix + String(seq).padStart(4, "0") + "-" + rand4;
}

/* ============================ إنشاء جلسة ============================ */

export interface CreateAssignmentInput {
  name: string;
  method: "PIN" | "USER";
  userId?: number;
  zone?: string;
  variantIds?: number[];
}

export interface CreateStocktakeInput {
  name: string;
  branchId: number;
  scopeType: "FULL" | "MOVING" | "CATEGORY" | "MANUAL";
  movingDays?: number;
  categoryIds?: number[];
  variantIds?: number[];
  blind?: boolean;
  thresholdPct?: string;
  thresholdValue?: string;
  dualThreshold?: string;
  directUnderThreshold?: boolean;
  waNotify?: boolean;
  dupPolicy?: "VERIFY" | "BLOCK";
  notes?: string;
  assignments: CreateAssignmentInput[];
}

export interface CreateStocktakeResult {
  sessionId: number;
  code: string;
  itemCount: number;
  assignments: {
    assignmentId: number;
    name: string;
    method: "PIN" | "USER";
    zone: string | null;
    /** يُعاد مرة واحدة فقط عند الإنشاء — لا يُخزَّن إلا الـhash. */
    pin?: string;
    itemCount: number;
  }[];
}

/** حلّ نطاق الجلسة إلى قائمة متغيّرات + تسمية عربية + تفاصيل JSON. */
async function resolveScope(
  tx: Tx,
  input: CreateStocktakeInput
): Promise<{ variantIds: number[]; label: string; detail: Record<string, unknown> }> {
  if (input.scopeType === "FULL") {
    const rows = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(eq(productVariants.isActive, true), eq(products.isActive, true)));
    const ids = rows.map((r) => Number(r.id));
    return { variantIds: ids, label: `جرد شامل للفرع (${ids.length} صنفاً)`, detail: {} };
  }

  if (input.scopeType === "MOVING") {
    const days = input.movingDays ?? 30;
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await tx
      .selectDistinct({ id: inventoryMovements.variantId })
      .from(inventoryMovements)
      .innerJoin(productVariants, eq(inventoryMovements.variantId, productVariants.id))
      .where(
        and(
          eq(inventoryMovements.branchId, input.branchId),
          gte(inventoryMovements.createdAt, since),
          eq(productVariants.isActive, true)
        )
      );
    const ids = rows.map((r) => Number(r.id));
    return {
      variantIds: ids,
      label: `أصناف عليها حركة آخر ${days} يوماً (${ids.length} صنفاً)`,
      detail: { days },
    };
  }

  if (input.scopeType === "CATEGORY") {
    const catIds = input.categoryIds ?? [];
    if (!catIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد فئة واحدة على الأقل لنطاق الجرد" });
    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.id, catIds));
    if (catRows.length !== catIds.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "إحدى الفئات المحددة غير موجودة" });
    }
    const rows = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(inArray(products.categoryId, catIds), eq(productVariants.isActive, true), eq(products.isActive, true)));
    const ids = rows.map((r) => Number(r.id));
    const names = catRows.map((c) => c.name).join("، ");
    return { variantIds: ids, label: `فئة: ${names} (${ids.length} صنفاً)`, detail: { categoryIds: catIds } };
  }

  // MANUAL
  const wanted = Array.from(new Set(input.variantIds ?? []));
  if (!wanted.length) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر صنفاً واحداً على الأقل لنطاق الجرد" });
  const found = await (async () => {
    const out: number[] = [];
    for (const part of chunk(wanted)) {
      const rows = await tx.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, part));
      out.push(...rows.map((r) => Number(r.id)));
    }
    return out;
  })();
  if (found.length !== wanted.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "بعض الأصناف المختارة غير موجودة في النظام" });
  }
  return { variantIds: wanted, label: `أصناف مختارة (${wanted.length} صنفاً)`, detail: { variantIds: wanted } };
}

/**
 * إنشاء جلسة جرد: حلّ النطاق + لقطة الرصيد الدفتري والتكلفة (ذرّياً داخل withTx) +
 * تكليفات العمّال (PIN crypto يُخزَّن hash فقط) + توزيع الأصناف (المُدّعى لصاحبه،
 * وغير المُكلَّف كتلاً متتالية متساوية ±1 على كل التكليفات بترتيب variantId تصاعدياً).
 * يعاد توليد الرمز مرة واحدة عند تصادم UNIQUE(code).
 */
export async function createStocktakeSession(
  input: CreateStocktakeInput,
  actor: StkActor
): Promise<CreateStocktakeResult> {
  // سباق على رمز الجلسة (UNIQUE) أو deadlock من قفل FOR UPDATE على نطاق الرمز ⇒ أعد المحاولة.
  // ⚠️ drizzle يغلّف الخطأ، فرمز MySQL يكون على cause لا على e مباشرةً — لذا نستخرجه بـmysqlCodeFrom
  // (الفحص القديم `e.code` لم يكن يلتقطه أبداً، فيتسرّب الـdeadlock ويُفشل الإنشاء المتزامن).
  const RETRYABLE = new Set(["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await withTx(async (tx) => createSessionInTx(tx, input, actor));
    } catch (e: unknown) {
      const code = mysqlCodeFrom(e);
      if (code && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS - 1) {
        // تراجع قصير عشوائيّ يكسر تناظر الـdeadlock بين المعاملتين المتزامنتين.
        await new Promise((r) => setTimeout(r, 15 + randomInt(60)));
        continue;
      }
      throw e;
    }
  }
  throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رمز الجلسة — أعد المحاولة" });
}

async function createSessionInTx(tx: Tx, input: CreateStocktakeInput, actor: StkActor): Promise<CreateStocktakeResult> {
  // الفرع موجود وفعّال.
  const br = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
  if (!br) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });

  // النطاق.
  const scope = await resolveScope(tx, input);
  if (!scope.variantIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نطاق الجرد لا يحوي أي صنف — راجع النطاق المحدد" });
  }
  const scopeSet = new Set(scope.variantIds);

  // تحقّق التكليفات: USER يلزمه userId موجود وفعّال وغير مكرّر؛ أصناف التكليف ضمن النطاق وبلا ازدواج.
  const userIds = input.assignments.filter((a) => a.method === "USER").map((a) => a.userId);
  if (userIds.some((u) => !u)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تكليف بحساب داخلي بلا مستخدم محدد" });
  }
  if (new Set(userIds).size !== userIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تكليف المستخدم نفسه بأكثر من منطقة في الجلسة الواحدة" });
  }
  if (userIds.length) {
    const found = await tx
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(inArray(users.id, userIds as number[]));
    const activeIds = new Set(found.filter((u) => u.isActive !== false).map((u) => Number(u.id)));
    for (const u of userIds as number[]) {
      if (!activeIds.has(u)) throw new TRPCError({ code: "BAD_REQUEST", message: "مستخدم التكليف غير موجود أو معطَّل" });
    }
  }
  const claimed = new Map<number, number>(); // variantId → فهرس التكليف
  input.assignments.forEach((a, idx) => {
    for (const v of a.variantIds ?? []) {
      if (!scopeSet.has(v)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `تكليف «${a.name}» يتضمن صنفاً خارج نطاق الجلسة` });
      }
      if (claimed.has(v)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "صنف واحد مُكلَّف لأكثر من عامل — كل صنف لمنطقة واحدة" });
      }
      claimed.set(v, idx);
    }
  });

  // لقطة الرصيد الدفتري + التكلفة (دفعات inArray ≤1000 — لا فصم للجلسة).
  const stockMap = new Map<number, number>();
  const costMap = new Map<number, string>();
  for (const part of chunk(scope.variantIds)) {
    const stockRows = await tx
      .select({ variantId: branchStock.variantId, quantity: branchStock.quantity })
      .from(branchStock)
      .where(and(eq(branchStock.branchId, input.branchId), inArray(branchStock.variantId, part)));
    for (const r of stockRows) stockMap.set(Number(r.variantId), r.quantity);
    const costRows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, part));
    for (const r of costRows) costMap.set(Number(r.id), String(r.cost ?? "0"));
  }

  // الجلسة.
  const code = await nextSessionCode(tx);
  const sessionValues: typeof stocktakeSessions.$inferInsert = {
    code,
    name: input.name,
    branchId: input.branchId,
    scopeType: input.scopeType,
    scopeDetail: JSON.stringify({ ...scope.detail, label: scope.label }),
    status: "COUNTING",
    createdBy: actor.userId,
    notes: input.notes ?? null,
  };
  if (input.blind !== undefined) sessionValues.blind = input.blind;
  if (input.thresholdPct !== undefined) sessionValues.thresholdPct = toDbMoney(input.thresholdPct);
  if (input.thresholdValue !== undefined) sessionValues.thresholdValue = toDbMoney(input.thresholdValue);
  if (input.dualThreshold !== undefined) sessionValues.dualThreshold = toDbMoney(input.dualThreshold);
  if (input.directUnderThreshold !== undefined) sessionValues.directUnderThreshold = input.directUnderThreshold;
  if (input.waNotify !== undefined) sessionValues.waNotify = input.waNotify;
  if (input.dupPolicy !== undefined) sessionValues.dupPolicy = input.dupPolicy;
  const sRes = await tx.insert(stocktakeSessions).values(sessionValues);
  const sessionId = extractInsertId(sRes);

  // التكليفات: PIN فريد داخل الجلسة، يُخزَّن hash فقط ويُعاد النص مرة واحدة.
  const usedPins = new Set<string>();
  const assignmentIds: number[] = [];
  const assignmentPins: (string | undefined)[] = [];
  for (const a of input.assignments) {
    let pin: string | undefined;
    let pinHash: string | null = null;
    if (a.method === "PIN") {
      pin = generateUniquePin(usedPins);
      pinHash = hashPassword(pin);
    }
    const aRes = await tx.insert(stocktakeAssignments).values({
      sessionId,
      name: a.name,
      method: a.method,
      userId: a.method === "USER" ? a.userId : null,
      pinHash,
      zone: a.zone ?? null,
      status: "ACTIVE",
    });
    assignmentIds.push(extractInsertId(aRes));
    assignmentPins.push(pin);
  }

  // توزيع الأصناف: المُدّعى لتكليفه يبقى له؛ وغير المُكلَّف بأي تكليف يُوزَّع كتلاً متتالية
  // متساوية (±1) على كل التكليفات بترتيب variantId تصاعدياً (تكليف واحد ⇒ يستلم الكل =
  // السلوك القديم نفسه). السبب: «الباقي للتكليف الأول» ينهار على جرد شامل حقيقي —
  // الواجهة ترسل ≤1000 معرّف للتكليفات بينما النطاق قد يبلغ آلاف الأصناف فيُغرَق الأول بها كلها.
  const unclaimed = scope.variantIds.filter((v) => !claimed.has(v)).sort((a, b) => a - b);
  const blockBase = Math.floor(unclaimed.length / input.assignments.length);
  const blockExtra = unclaimed.length % input.assignments.length;
  for (let idx = 0, cursor = 0; idx < input.assignments.length; idx++) {
    const size = blockBase + (idx < blockExtra ? 1 : 0);
    for (const v of unclaimed.slice(cursor, cursor + size)) claimed.set(v, idx);
    cursor += size;
  }
  const perAssignmentCount = new Array(input.assignments.length).fill(0) as number[];
  const itemRows = scope.variantIds.map((variantId) => {
    const idx = claimed.get(variantId)!; // كل صنف صار مملوكاً: ادّعاءً أو بالتوزيع الكتلي
    perAssignmentCount[idx] += 1;
    return {
      sessionId,
      assignmentId: assignmentIds[idx],
      variantId,
      branchId: input.branchId,
      expectedQty: stockMap.get(variantId) ?? 0,
      unitCost: toDbMoney(costMap.get(variantId) ?? "0"),
    };
  });
  for (const part of chunk(itemRows, 1000)) {
    await tx.insert(stocktakeItems).values(part);
  }

  return {
    sessionId,
    code,
    itemCount: scope.variantIds.length,
    assignments: input.assignments.map((a, idx) => ({
      assignmentId: assignmentIds[idx],
      name: a.name,
      method: a.method,
      zone: a.zone ?? null,
      pin: assignmentPins[idx],
      itemCount: perAssignmentCount[idx],
    })),
  };
}

/* ============================ القائمة والترويسة والمتابعة ============================ */

export interface ListStocktakesOpts {
  status?: "COUNTING" | "REVIEW" | "APPROVED" | "CANCELLED";
  branchId?: number;
  limit?: number;
  offset?: number;
}

export async function listStocktakeSessions(opts: ListStocktakesOpts = {}) {
  const db = requireDb();
  const conds = [] as ReturnType<typeof eq>[];
  if (opts.status) conds.push(eq(stocktakeSessions.status, opts.status));
  if (opts.branchId) conds.push(eq(stocktakeSessions.branchId, opts.branchId));

  const rows = await db
    .select({
      id: stocktakeSessions.id,
      code: stocktakeSessions.code,
      name: stocktakeSessions.name,
      branchId: stocktakeSessions.branchId,
      branchName: branches.name,
      scopeType: stocktakeSessions.scopeType,
      scopeDetail: stocktakeSessions.scopeDetail,
      status: stocktakeSessions.status,
      createdAt: stocktakeSessions.createdAt,
      createdByName: users.name,
      submittedAt: stocktakeSessions.submittedAt,
      approvedAt: stocktakeSessions.approvedAt,
    })
    .from(stocktakeSessions)
    .leftJoin(branches, eq(stocktakeSessions.branchId, branches.id))
    .leftJoin(users, eq(stocktakeSessions.createdBy, users.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(stocktakeSessions.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  const ids = rows.map((r) => Number(r.id));
  const itemCountMap = new Map<number, number>();
  const countedMap = new Map<number, number>();
  if (ids.length) {
    const itemCounts = await db
      .select({ sessionId: stocktakeItems.sessionId, c: sql<number>`COUNT(*)` })
      .from(stocktakeItems)
      .where(inArray(stocktakeItems.sessionId, ids))
      .groupBy(stocktakeItems.sessionId);
    for (const r of itemCounts) itemCountMap.set(Number(r.sessionId), Number(r.c));
    const counted = await db
      .select({ sessionId: stocktakeCounts.sessionId, c: sql<number>`COUNT(DISTINCT ${stocktakeCounts.variantId})` })
      .from(stocktakeCounts)
      .where(inArray(stocktakeCounts.sessionId, ids))
      .groupBy(stocktakeCounts.sessionId);
    for (const r of counted) countedMap.set(Number(r.sessionId), Number(r.c));
  }

  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    branchId: Number(r.branchId),
    branchName: r.branchName ?? "—",
    scopeType: r.scopeType,
    scopeLabel: scopeLabelOf(r.scopeType, r.scopeDetail),
    status: r.status,
    itemCount: itemCountMap.get(Number(r.id)) ?? 0,
    countedCount: countedMap.get(Number(r.id)) ?? 0,
    createdAt: r.createdAt,
    createdByName: r.createdByName ?? "—",
    submittedAt: r.submittedAt,
    approvedAt: r.approvedAt,
  }));
}

/** ترويسة الجلسة (مع أسماء المنشئ/الموقّعَين) — بلا pinHash أبداً. */
async function loadSessionHeader(db: DbLike, sessionId: number) {
  const creator = alias(users, "stkCreator");
  const signer = alias(users, "stkSigner");
  const approver = alias(users, "stkApprover");
  const canceller = alias(users, "stkCanceller");
  const rows = await db
    .select({
      id: stocktakeSessions.id,
      code: stocktakeSessions.code,
      name: stocktakeSessions.name,
      branchId: stocktakeSessions.branchId,
      branchName: branches.name,
      scopeType: stocktakeSessions.scopeType,
      scopeDetail: stocktakeSessions.scopeDetail,
      status: stocktakeSessions.status,
      blind: stocktakeSessions.blind,
      thresholdPct: stocktakeSessions.thresholdPct,
      thresholdValue: stocktakeSessions.thresholdValue,
      dualThreshold: stocktakeSessions.dualThreshold,
      directUnderThreshold: stocktakeSessions.directUnderThreshold,
      waNotify: stocktakeSessions.waNotify,
      dupPolicy: stocktakeSessions.dupPolicy,
      notes: stocktakeSessions.notes,
      createdAt: stocktakeSessions.createdAt,
      createdBy: stocktakeSessions.createdBy,
      createdByName: creator.name,
      submittedAt: stocktakeSessions.submittedAt,
      firstSignBy: stocktakeSessions.firstSignBy,
      firstSignAt: stocktakeSessions.firstSignAt,
      firstSignByName: signer.name,
      approvedBy: stocktakeSessions.approvedBy,
      approvedAt: stocktakeSessions.approvedAt,
      approvedByName: approver.name,
      cancelledAt: stocktakeSessions.cancelledAt,
      cancelledByName: canceller.name,
    })
    .from(stocktakeSessions)
    .leftJoin(branches, eq(stocktakeSessions.branchId, branches.id))
    .leftJoin(creator, eq(stocktakeSessions.createdBy, creator.id))
    .leftJoin(signer, eq(stocktakeSessions.firstSignBy, signer.id))
    .leftJoin(approver, eq(stocktakeSessions.approvedBy, approver.id))
    .leftJoin(canceller, eq(stocktakeSessions.cancelledBy, canceller.id))
    .where(eq(stocktakeSessions.id, sessionId))
    .limit(1);
  const s = rows[0];
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة" });
  return s;
}

function assertBranchAccess(sessionBranchId: number, restrictBranchId: number | null | undefined) {
  if (restrictBranchId != null && Number(sessionBranchId) !== Number(restrictBranchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا صلاحية على جلسات فرع آخر" });
  }
}

/** تقدّم كل تكليف: إجمالي أصنافه + المعدود منها (من أي عامل — VERIFY يُحتسب عدّاً). */
async function loadAssignmentProgress(db: DbLike, sessionId: number) {
  const asg = await db
    .select({
      id: stocktakeAssignments.id,
      name: stocktakeAssignments.name,
      method: stocktakeAssignments.method,
      userId: stocktakeAssignments.userId,
      zone: stocktakeAssignments.zone,
      status: stocktakeAssignments.status,
      lastActivityAt: stocktakeAssignments.lastActivityAt,
      submittedAt: stocktakeAssignments.submittedAt,
    })
    .from(stocktakeAssignments)
    .where(eq(stocktakeAssignments.sessionId, sessionId))
    .orderBy(asc(stocktakeAssignments.id));

  const totals = await db
    .select({ assignmentId: stocktakeItems.assignmentId, c: sql<number>`COUNT(*)` })
    .from(stocktakeItems)
    .where(eq(stocktakeItems.sessionId, sessionId))
    .groupBy(stocktakeItems.assignmentId);
  const totalMap = new Map(totals.map((r) => [Number(r.assignmentId), Number(r.c)]));

  const counted = await db
    .select({
      assignmentId: stocktakeItems.assignmentId,
      c: sql<number>`COUNT(DISTINCT ${stocktakeCounts.variantId})`,
    })
    .from(stocktakeItems)
    .innerJoin(
      stocktakeCounts,
      and(eq(stocktakeCounts.sessionId, stocktakeItems.sessionId), eq(stocktakeCounts.variantId, stocktakeItems.variantId))
    )
    .where(eq(stocktakeItems.sessionId, sessionId))
    .groupBy(stocktakeItems.assignmentId);
  const countedByAsg = new Map(counted.map((r) => [Number(r.assignmentId), Number(r.c)]));

  return asg.map((a) => ({
    id: Number(a.id),
    name: a.name,
    method: a.method,
    userId: a.userId == null ? null : Number(a.userId),
    zone: a.zone,
    status: a.status,
    total: totalMap.get(Number(a.id)) ?? 0,
    counted: countedByAsg.get(Number(a.id)) ?? 0,
    lastActivityAt: a.lastActivityAt,
    submittedAt: a.submittedAt,
  }));
}

export async function getStocktakeSession(sessionId: number, opts: { restrictBranchId?: number | null } = {}) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
  const assignments = await loadAssignmentProgress(db, sessionId);
  const total = assignments.reduce((acc, a) => acc + a.total, 0);
  const counted = assignments.reduce((acc, a) => acc + a.counted, 0);
  return {
    session: {
      id: Number(s.id),
      code: s.code,
      name: s.name,
      branchId: Number(s.branchId),
      branchName: s.branchName ?? "—",
      scopeType: s.scopeType,
      scopeLabel: scopeLabelOf(s.scopeType, s.scopeDetail),
      status: s.status,
      blind: !!s.blind,
      thresholdPct: String(s.thresholdPct),
      thresholdValue: String(s.thresholdValue),
      dualThreshold: String(s.dualThreshold),
      directUnderThreshold: !!s.directUnderThreshold,
      waNotify: !!s.waNotify,
      dupPolicy: s.dupPolicy,
      notes: s.notes,
      createdAt: s.createdAt,
      createdByName: s.createdByName ?? "—",
      submittedAt: s.submittedAt,
      firstSign: s.firstSignBy ? { byName: s.firstSignByName ?? "—", at: s.firstSignAt } : null,
      approved: s.approvedBy ? { byName: s.approvedByName ?? "—", at: s.approvedAt } : null,
      cancelled: s.cancelledAt ? { byName: s.cancelledByName ?? "—", at: s.cancelledAt } : null,
    },
    assignments,
    progress: { total, counted },
  };
}

/**
 * شاشة المتابعة الحية — بلا expectedQty ولا تكاليف (تصل لدور warehouse).
 * `opts.q` (عقد مع الواجهة): حين محددة تُستبدل recentCounts بالعدّات المطابقة
 * (LIKE على اسم المنتج أو sku أو اسم المتغيّر، حتى 50، الأحدث أولاً) بدل آخر 20.
 * وفي الحالتين كل عنصر يحمل `baseUnit` (اسم وحدة الأساس) كي تعرض الشاشة «139 رزمة».
 */
export async function monitorStocktakeSession(
  sessionId: number,
  opts: { restrictBranchId?: number | null; q?: string } = {}
) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
  const assignments = await loadAssignmentProgress(db, sessionId);

  const q = opts.q?.trim() ?? "";
  // تهريب محارف LIKE من مدخل المستخدم — «%» المُدخلة تطابق نصاً لا كل شيء.
  const likePattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const recentWhere = q
    ? and(
        eq(stocktakeCounts.sessionId, sessionId),
        or(
          like(products.name, likePattern),
          like(productVariants.sku, likePattern),
          like(productVariants.variantName, likePattern)
        )
      )
    : eq(stocktakeCounts.sessionId, sessionId);
  const recentRaw = await db
    .select({
      id: stocktakeCounts.id,
      variantId: stocktakeCounts.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      baseUnit: productUnits.unitName,
      qty: stocktakeCounts.qty,
      kind: stocktakeCounts.kind,
      byName: stocktakeCounts.countedByName,
      at: stocktakeCounts.countedAt,
    })
    .from(stocktakeCounts)
    .innerJoin(productVariants, eq(stocktakeCounts.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, and(eq(productUnits.variantId, stocktakeCounts.variantId), eq(productUnits.isBaseUnit, true)))
    .where(recentWhere)
    .orderBy(desc(stocktakeCounts.countedAt), desc(stocktakeCounts.id))
    .limit(q ? 50 : 20);
  // عدّة وحدات أساس لصنف (شذوذ بيانات) = صفوف مكرّرة من الـjoin ⇒ أول صف لكل عدّة يفوز.
  const seenCountIds = new Set<number>();
  const recent = recentRaw.filter((r) => {
    const id = Number(r.id);
    if (seenCountIds.has(id)) return false;
    seenCountIds.add(id);
    return true;
  });

  // إعادات العدّ المعلّقة — تفصيلية (الشاشة تعرضها لافتةً بأسبابها).
  const pendingItems = await db
    .select({
      variantId: stocktakeItems.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      reason: stocktakeItems.recountReason,
      requestedByName: users.name,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(users, eq(stocktakeItems.recountRequestedBy, users.id))
    .where(and(eq(stocktakeItems.sessionId, sessionId), eq(stocktakeItems.recountStatus, "PENDING")));

  // التعارضات المفتوحة (VERIFY مخالف بلا فصل) — مع العدّ الأول المقابل لعرض «زيد 510 / كرار 498».
  const conflictVerifies = await db
    .select({
      variantId: stocktakeCounts.variantId,
      qty2: stocktakeCounts.qty,
      by2: stocktakeCounts.countedByName,
      productName: products.name,
      variantName: productVariants.variantName,
    })
    .from(stocktakeCounts)
    .innerJoin(productVariants, eq(stocktakeCounts.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(stocktakeCounts.sessionId, sessionId),
        eq(stocktakeCounts.isConflict, true),
        sql`${stocktakeCounts.resolvedPick} IS NULL`
      )
    );
  const conflictFirsts = conflictVerifies.length
    ? await db
        .select({ variantId: stocktakeCounts.variantId, qty: stocktakeCounts.qty, byName: stocktakeCounts.countedByName })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, sessionId),
            inArray(stocktakeCounts.variantId, conflictVerifies.map((c) => Number(c.variantId))),
            eq(stocktakeCounts.kind, "FIRST")
          )
        )
    : [];
  const firstByVariant = new Map(conflictFirsts.map((f) => [Number(f.variantId), f]));
  const labelOf = (p: string | null, v: string | null) => (v ? `${p} — ${v}` : String(p ?? ""));

  return {
    session: {
      id: Number(s.id),
      code: s.code,
      name: s.name,
      branchId: Number(s.branchId),
      branchName: s.branchName ?? "—",
      scopeType: s.scopeType,
      scopeLabel: scopeLabelOf(s.scopeType, s.scopeDetail),
      status: s.status,
      blind: !!s.blind,
      waNotify: !!s.waNotify,
      dupPolicy: s.dupPolicy,
      createdAt: s.createdAt,
      createdByName: s.createdByName ?? "—",
      submittedAt: s.submittedAt,
    },
    assignments: assignments.map((a) => ({
      id: a.id,
      name: a.name,
      method: a.method,
      zone: a.zone,
      status: a.status,
      total: a.total,
      counted: a.counted,
      lastActivityAt: a.lastActivityAt,
    })),
    recentCounts: recent.map((r) => ({
      variantId: Number(r.variantId),
      variantLabel: labelOf(r.productName, r.variantName),
      qty: r.qty,
      kind: r.kind,
      byName: r.byName,
      at: r.at,
      baseUnit: r.baseUnit ?? null,
    })),
    pendingRecounts: pendingItems.map((p) => ({
      variantId: Number(p.variantId),
      variantLabel: labelOf(p.productName, p.variantName),
      reason: p.reason ?? "—",
      requestedByName: p.requestedByName ?? "—",
    })),
    conflicts: conflictVerifies.map((c) => ({
      variantId: Number(c.variantId),
      variantLabel: labelOf(c.productName, c.variantName),
      qty1: firstByVariant.get(Number(c.variantId))?.qty ?? 0,
      by1: firstByVariant.get(Number(c.variantId))?.byName ?? "—",
      qty2: c.qty2,
      by2: c.by2,
    })),
  };
}

/* ============================ محرّك المراجعة (العقد §٤) ============================ */

interface CountRow {
  id: number;
  variantId: number;
  kind: "FIRST" | "RECOUNT" | "VERIFY";
  qty: number;
  countedByName: string;
  countedAt: Date;
  isConflict: boolean;
  resolvedPick: "FIRST" | "VERIFY" | null;
}

export interface ReviewRow {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  baseUnit: string | null;
  zone: string | null;
  assignmentName: string;
  expectedQty: number;
  rawCount: number | null;
  kindUsed: "FIRST" | "RECOUNT" | null;
  countedByName: string | null;
  countedAt: Date | null;
  recount: { status: "PENDING" | "DONE"; reason: string | null; requestedByName: string | null; qty2: number | null } | null;
  verify: { qty: number; byName: string; at: Date; match: boolean } | null;
  conflict: { qty1: number | null; by1: string | null; qty2: number; by2: string; resolvedPick: "FIRST" | "VERIFY" | null } | null;
  movesAfter: { type: string; qty: number; ref: string; at: Date }[];
  netAfter: number;
  adjustedCount: number | null;
  bookNow: number;
  diff: number | null;
  value: string | null;
  pct: number | null;
  withinThreshold: boolean;
  overThreshold: boolean;
  requiresDualSign: boolean;
  decision: {
    action: "ADJUST" | "KEEP";
    reason: string;
    note: string | null;
    decidedByName: string | null;
    autoApplied: boolean;
  } | null;
  /** داخلي للاعتماد (لا يظهر في عقد الواجهة لكنه غير ضار). */
  unitCost: string;
  decidedBy: number | null;
  openConflict: boolean;
}

/**
 * تحميل بيانات المراجعة وحسابها — ٦ استعلامات مجمّعة (بلا N+1):
 * ١ الجلسة+الأسماء، ٢ الأصناف+التسميات، ٣ العدّات، ٤ أرصدة الآن، ٥ الحركات اللاحقة، ٦ القرارات.
 * المعادلات حرفياً من العقد §٢ (مصدرها jrd-data.jsx):
 *   rawCount = آخر RECOUNT وإلا FIRST (مع resolvedPick عند تعارض VERIFY)
 *   adjustedCount = rawCount + netAfter (عند autoAdjust)
 *   diff = adjustedCount − bookNow ، value = diff × unitCost(لقطة) ، pct = |diff|/expectedQty×100
 */
async function loadReviewCore(db: DbLike, sessionId: number, autoAdjust: boolean) {
  // (١) الجلسة.
  const s = await loadSessionHeader(db, sessionId);
  const branchId = Number(s.branchId);

  // (٢) الأصناف + المتغيّر/المنتج/الوحدة الأساس/التكليف/طالب إعادة العدّ.
  const requester = alias(users, "stkRecountReq");
  const itemRows = await db
    .select({
      variantId: stocktakeItems.variantId,
      expectedQty: stocktakeItems.expectedQty,
      unitCost: stocktakeItems.unitCost,
      recountStatus: stocktakeItems.recountStatus,
      recountReason: stocktakeItems.recountReason,
      recountRequestedByName: requester.name,
      assignmentName: stocktakeAssignments.name,
      zone: stocktakeAssignments.zone,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      baseUnit: productUnits.unitName,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, and(eq(productUnits.variantId, stocktakeItems.variantId), eq(productUnits.isBaseUnit, true)))
    .innerJoin(stocktakeAssignments, eq(stocktakeItems.assignmentId, stocktakeAssignments.id))
    .leftJoin(requester, eq(stocktakeItems.recountRequestedBy, requester.id))
    .where(eq(stocktakeItems.sessionId, sessionId))
    .orderBy(asc(stocktakeItems.id));
  // عدّة وحدات أساس لمتغيّر = صفوف مكرّرة من الـjoin ⇒ أول صف يفوز.
  const items: typeof itemRows = [];
  const seenVariants = new Set<number>();
  for (const r of itemRows) {
    const v = Number(r.variantId);
    if (seenVariants.has(v)) continue;
    seenVariants.add(v);
    items.push(r);
  }

  // (٣) كل العدّات مرتّبة زمنياً.
  const countRowsRaw = await db
    .select({
      id: stocktakeCounts.id,
      variantId: stocktakeCounts.variantId,
      kind: stocktakeCounts.kind,
      qty: stocktakeCounts.qty,
      countedByName: stocktakeCounts.countedByName,
      countedAt: stocktakeCounts.countedAt,
      isConflict: stocktakeCounts.isConflict,
      resolvedPick: stocktakeCounts.resolvedPick,
    })
    .from(stocktakeCounts)
    .where(eq(stocktakeCounts.sessionId, sessionId))
    .orderBy(asc(stocktakeCounts.countedAt), asc(stocktakeCounts.id));
  const countsByVariant = new Map<number, CountRow[]>();
  for (const c of countRowsRaw) {
    const v = Number(c.variantId);
    const list = countsByVariant.get(v) ?? [];
    list.push({
      id: Number(c.id),
      variantId: v,
      kind: c.kind,
      qty: c.qty,
      countedByName: c.countedByName,
      countedAt: c.countedAt,
      isConflict: !!c.isConflict,
      resolvedPick: c.resolvedPick ?? null,
    });
    countsByVariant.set(v, list);
  }

  // (٤) أرصدة الآن (bookNow) لكل أصناف الجلسة.
  const variantIds = items.map((r) => Number(r.variantId));
  const stockNow = new Map<number, number>();
  for (const part of chunk(variantIds)) {
    const rows = await db
      .select({ variantId: branchStock.variantId, quantity: branchStock.quantity })
      .from(branchStock)
      .where(and(eq(branchStock.branchId, branchId), inArray(branchStock.variantId, part)));
    for (const r of rows) stockNow.set(Number(r.variantId), r.quantity);
  }

  // (٥) الحركات بعد العدّ: حركات الفرع على الأصناف المعدودة منذ أقدم عدّ، ثم تُرشَّح
  // لكل صنف بعد لحظة عدّه الفعّال. تُستبعد تسويات هذه الجلسة نفسها (STOCKTAKE:<id>)
  // كي لا يلوّث الاعتماد السابق إعادة الحساب (idempotency/التقرير).
  const countedVariantIds = Array.from(countsByVariant.keys());
  let minCountedAt: Date | null = null;
  for (const list of Array.from(countsByVariant.values())) {
    for (const c of list) {
      if (!minCountedAt || c.countedAt < minCountedAt) minCountedAt = c.countedAt;
    }
  }
  type MoveRow = {
    variantId: number;
    movementType: string;
    quantity: number;
    referenceType: string | null;
    referenceId: number | null;
    notes: string | null;
    createdAt: Date;
  };
  const movesByVariant = new Map<number, MoveRow[]>();
  if (countedVariantIds.length && minCountedAt) {
    for (const part of chunk(countedVariantIds)) {
      const rows = await db
        .select({
          variantId: inventoryMovements.variantId,
          movementType: inventoryMovements.movementType,
          quantity: inventoryMovements.quantity,
          referenceType: inventoryMovements.referenceType,
          referenceId: inventoryMovements.referenceId,
          notes: inventoryMovements.notes,
          createdAt: inventoryMovements.createdAt,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.branchId, branchId),
            inArray(inventoryMovements.variantId, part),
            gt(inventoryMovements.createdAt, minCountedAt)
          )
        )
        .orderBy(asc(inventoryMovements.createdAt), asc(inventoryMovements.id));
      for (const m of rows) {
        if (m.referenceType === "STOCKTAKE" && Number(m.referenceId) === sessionId) continue; // تسوية الجلسة نفسها
        const v = Number(m.variantId);
        const list = movesByVariant.get(v) ?? [];
        list.push({ ...m, variantId: v, referenceId: m.referenceId == null ? null : Number(m.referenceId) });
        movesByVariant.set(v, list);
      }
    }
  }

  // (٦) القرارات + اسم المقرِّر.
  const decisionRows = await db
    .select({
      variantId: stocktakeDecisions.variantId,
      action: stocktakeDecisions.action,
      finalQty: stocktakeDecisions.finalQty,
      diffQty: stocktakeDecisions.diffQty,
      value: stocktakeDecisions.value,
      reason: stocktakeDecisions.reason,
      note: stocktakeDecisions.note,
      decidedBy: stocktakeDecisions.decidedBy,
      decidedByName: users.name,
      autoApplied: stocktakeDecisions.autoApplied,
    })
    .from(stocktakeDecisions)
    .leftJoin(users, eq(stocktakeDecisions.decidedBy, users.id))
    .where(eq(stocktakeDecisions.sessionId, sessionId));
  const decisionMap = new Map(decisionRows.map((d) => [Number(d.variantId), d]));

  // ── الحساب لكل صنف ──
  const thresholdPct = money(String(s.thresholdPct));
  const thresholdValue = money(String(s.thresholdValue));
  const dualThreshold = money(String(s.dualThreshold));
  const directUnderThreshold = !!s.directUnderThreshold;

  const rows: ReviewRow[] = items.map((it) => {
    const v = Number(it.variantId);
    const cs = countsByVariant.get(v) ?? [];
    const firsts = cs.filter((c) => c.kind === "FIRST");
    const recounts = cs.filter((c) => c.kind === "RECOUNT");
    const verifies = cs.filter((c) => c.kind === "VERIFY");
    const first = firsts.length ? firsts[firsts.length - 1] : null;
    const recount = recounts.length ? recounts[recounts.length - 1] : null;
    const verify = verifies.length ? verifies[verifies.length - 1] : null;

    // العدّ الفعّال: RECOUNT الأحدث يحلّ محل الجميع؛ وإلا FIRST (أو VERIFY إن فُصل التعارض لصالحه).
    let used: CountRow | null = null;
    let kindUsed: "FIRST" | "RECOUNT" | null = null;
    if (recount) {
      used = recount;
      kindUsed = "RECOUNT";
    } else if (first) {
      if (verify && verify.isConflict && verify.resolvedPick === "VERIFY") used = verify;
      else used = first;
      kindUsed = "FIRST";
    }
    const rawCount = used ? used.qty : null;

    // تعارض مفتوح = VERIFY مخالف بلا فصل وبلا RECOUNT لاحق (العدّ الثالث يمسح التعارض).
    const openConflict = !!(verify && verify.isConflict && !verify.resolvedPick && !recount);
    const conflict = verify && verify.isConflict
      ? {
          qty1: first ? first.qty : null,
          by1: first ? first.countedByName : null,
          qty2: verify.qty,
          by2: verify.countedByName,
          resolvedPick: verify.resolvedPick,
        }
      : null;
    const verifyObj = verify
      ? { qty: verify.qty, byName: verify.countedByName, at: verify.countedAt, match: first ? verify.qty === first.qty : false }
      : null;
    const recountObj = it.recountStatus
      ? {
          status: it.recountStatus,
          reason: it.recountReason,
          requestedByName: it.recountRequestedByName,
          qty2: recount ? recount.qty : null,
        }
      : null;

    // الحركات بعد لحظة العدّ الفعّال (الإشارة حسب نوع الحركة — تطابق inventoryService).
    const allMoves = used ? (movesByVariant.get(v) ?? []).filter((m) => m.createdAt > used!.countedAt) : [];
    const movesAfter = allMoves.map((m) => ({
      type: MOVE_LABEL[m.movementType] ?? m.movementType,
      qty: signedMoveQty(m.movementType, m.quantity, m.notes),
      ref: m.referenceType ? `${m.referenceType}${m.referenceId != null ? `#${m.referenceId}` : ""}` : "—",
      at: m.createdAt,
    }));
    const netAfter = movesAfter.reduce((acc, m) => acc + m.qty, 0);

    const adjustedCount = rawCount == null ? null : rawCount + (autoAdjust ? netAfter : 0);
    const bookNow = stockNow.get(v) ?? 0;
    const diff = adjustedCount == null ? null : adjustedCount - bookNow;
    const unitCost = String(it.unitCost ?? "0");
    const valueDec = diff == null ? null : money(unitCost).times(diff);
    const value = valueDec == null ? null : toDbMoney(valueDec);
    // النسبة الخام للمقارنة بالحدّ (التقريب للعرض فقط — تقريبها قبل المقارنة يُمرّر 5.004% كـ«ضمن 5%»).
    const pctRaw = diff == null || it.expectedQty === 0 ? null : money(Math.abs(diff)).div(it.expectedQty).times(100);
    const pct = pctRaw == null ? null : pctRaw.toDecimalPlaces(2).toNumber();
    // «ضمن الحد»: pct≤حد النسبة (يُعفى إن تعذّر حسابه expectedQty=0 — كنموذج jrd-data) و|القيمة|≤حد القيمة.
    const pctOk = pctRaw == null || pctRaw.lte(thresholdPct);
    const valueOk = valueDec != null && valueDec.abs().lte(thresholdValue);
    const withinThreshold = diff != null && pctOk && valueOk;
    const overThreshold = diff != null && diff !== 0 && !withinThreshold;
    const requiresDualSign = valueDec != null && valueDec.abs().gt(dualThreshold);

    const d = decisionMap.get(v);
    const decision = d
      ? {
          action: d.action,
          reason: d.reason,
          note: d.note,
          decidedByName: d.decidedBy == null ? null : (d.decidedByName ?? "—"),
          autoApplied: !!d.autoApplied,
        }
      : null;

    return {
      variantId: v,
      productName: String(it.productName ?? ""),
      variantName: it.variantName,
      sku: it.sku,
      baseUnit: it.baseUnit,
      zone: it.zone,
      assignmentName: it.assignmentName,
      expectedQty: it.expectedQty,
      rawCount,
      kindUsed,
      countedByName: used ? used.countedByName : null,
      countedAt: used ? used.countedAt : null,
      recount: recountObj,
      verify: verifyObj,
      conflict,
      movesAfter,
      netAfter,
      adjustedCount,
      bookNow,
      diff,
      value,
      pct,
      withinThreshold,
      overThreshold,
      requiresDualSign,
      decision,
      unitCost,
      decidedBy: d?.decidedBy == null ? null : Number(d.decidedBy),
      openConflict,
    };
  });

  return { s, rows, directUnderThreshold };
}

/** هل سيُسوّى الصف عند الاعتماد؟ (قرار ADJUST صريح، أو تلقائي ضمن الحد عند directUnderThreshold). */
function willAdjust(row: ReviewRow, directUnderThreshold: boolean): boolean {
  if (row.diff == null || row.diff === 0) return false;
  if (row.decision) return row.decision.action === "ADJUST";
  return row.withinThreshold && directUnderThreshold;
}

function buildTotals(rows: ReviewRow[]) {
  let counted = 0;
  let matched = 0;
  let over = 0;
  let short = 0;
  let overThr = 0;
  let netValue = money(0);
  let shortValue = money(0);
  let overValue = money(0);
  for (const r of rows) {
    if (r.diff == null) continue;
    counted++;
    if (r.diff === 0) matched++;
    else if (r.diff > 0) {
      over++;
      overValue = overValue.plus(money(r.value ?? 0));
    } else {
      short++;
      shortValue = shortValue.plus(money(r.value ?? 0));
    }
    if (r.overThreshold) overThr++;
    netValue = netValue.plus(money(r.value ?? 0));
  }
  return {
    total: rows.length,
    counted,
    matched,
    over,
    short,
    overThr,
    netValue: toDbMoney(netValue),
    shortValue: toDbMoney(shortValue),
    overValue: toDbMoney(overValue),
  };
}

/** معاينة القيد الدفتري: عجز/زيادة لما سيُسوّى فعلاً (KEEP لا يدخل القيد). */
function buildLedgerPreview(rows: ReviewRow[], directUnderThreshold: boolean) {
  let shortExpense = money(0);
  let overGain = money(0);
  for (const r of rows) {
    if (!willAdjust(r, directUnderThreshold)) continue;
    const v = money(r.value ?? 0);
    if ((r.diff ?? 0) < 0) shortExpense = shortExpense.plus(v.abs());
    else overGain = overGain.plus(v);
  }
  return { shortExpense: toDbMoney(shortExpense), overGain: toDbMoney(overGain) };
}

function buildBarriers(
  rows: ReviewRow[],
  s: Awaited<ReturnType<typeof loadSessionHeader>>,
  directUnderThreshold: boolean,
  viewerId?: number
) {
  const notCounted = rows.filter((r) => r.rawCount == null).length;
  const pendingRecounts = rows.filter((r) => r.recount?.status === "PENDING").length;
  const openConflicts = rows.filter((r) => r.openConflict).length;
  // يحتاج قراراً صريحاً: يتجاوز الحد دائماً؛ وكل فرق ≠0 عندما تكون التسوية المباشرة معطّلة.
  const undecidedOverThreshold = rows.filter((r) => {
    if (r.diff == null || r.diff === 0 || r.decision) return false;
    if (r.recount?.status === "PENDING" || r.openConflict) return false; // محسوبة في حاجزها
    return r.overThreshold || !directUnderThreshold;
  }).length;
  const requiresDualSign = rows.some((r) => r.requiresDualSign && willAdjust(r, directUnderThreshold));
  const firstSigned = s.firstSignBy != null;
  const canApprove =
    s.status === "REVIEW" && pendingRecounts === 0 && openConflicts === 0 && undecidedOverThreshold === 0;
  const canFinalApprove =
    canApprove &&
    (!requiresDualSign || (firstSigned && viewerId != null && Number(s.firstSignBy) !== Number(viewerId)));
  return { notCounted, pendingRecounts, openConflicts, undecidedOverThreshold, requiresDualSign, firstSigned, canApprove, canFinalApprove };
}

function buildReviewSession(s: Awaited<ReturnType<typeof loadSessionHeader>>) {
  return {
    id: Number(s.id),
    code: s.code,
    name: s.name,
    branchId: Number(s.branchId),
    branchName: s.branchName ?? "—",
    status: s.status,
    blind: !!s.blind,
    thresholdPct: String(s.thresholdPct),
    thresholdValue: String(s.thresholdValue),
    dualThreshold: String(s.dualThreshold),
    directUnderThreshold: !!s.directUnderThreshold,
    dupPolicy: s.dupPolicy,
    createdAt: s.createdAt,
    createdByName: s.createdByName ?? "—",
    submittedAt: s.submittedAt,
    firstSign: s.firstSignBy ? { byName: s.firstSignByName ?? "—", at: s.firstSignAt } : null,
    approved: s.approvedBy ? { byName: s.approvedByName ?? "—", at: s.approvedAt } : null,
  };
}

/** مخرج شاشة المراجعة — العقد §٤ حرفياً. الصفوف لا تتضمن أسراراً إضافية للمدير+. */
export async function computeStocktakeReview(
  sessionId: number,
  opts: { autoAdjust?: boolean; viewerId?: number } = {}
) {
  const db = requireDb();
  const autoAdjust = opts.autoAdjust ?? true;
  const { s, rows, directUnderThreshold } = await loadReviewCore(db, sessionId, autoAdjust);
  return {
    session: buildReviewSession(s),
    rows: rows.map(({ decidedBy: _db2, openConflict: _oc, ...pub }) => pub),
    totals: buildTotals(rows),
    barriers: buildBarriers(rows, s, directUnderThreshold, opts.viewerId),
    ledgerPreview: buildLedgerPreview(rows, directUnderThreshold),
  };
}

/* ============================ معاملات المراجعة ============================ */

/** قفل صف الجلسة داخل المعاملة — يسلسل الاعتماد/القرارات المتزامنة. */
async function lockSession(tx: Tx, sessionId: number) {
  const rows = await tx.select().from(stocktakeSessions).where(eq(stocktakeSessions.id, sessionId)).for("update").limit(1);
  const s = rows[0];
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "جلسة الجرد غير موجودة" });
  return s;
}

async function getSessionItem(tx: Tx, sessionId: number, variantId: number) {
  const rows = await tx
    .select()
    .from(stocktakeItems)
    .where(and(eq(stocktakeItems.sessionId, sessionId), eq(stocktakeItems.variantId, variantId)))
    .limit(1);
  const item = rows[0];
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "الصنف ليس ضمن أصناف هذه الجلسة" });
  return item;
}

/**
 * طلب إعادة عدّ: مهمة PENDING تحجب الاعتماد حتى يصل عدّ RECOUNT عبر البوابة.
 * البوابة تشترط جلسة COUNTING وتكليفاً ACTIVE ⇒ نعيد فتحهما عند الطلب أثناء المراجعة
 * (وعند تسليم الجميع مجدداً تعود الجلسة لـREVIEW آلياً) — هذا هو التفسير المتّسق للعقد §٥.
 */
export async function requestStocktakeRecount(
  args: { sessionId: number; variantId: number; reason: string },
  actor: StkActor,
  opts: { restrictBranchId?: number | null } = {}
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن طلب إعادة عدّ على جلسة معتمدة أو ملغاة" });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    const hasCount = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(and(eq(stocktakeCounts.sessionId, args.sessionId), eq(stocktakeCounts.variantId, args.variantId)))
        .limit(1)
    )[0];
    if (!hasCount) throw new TRPCError({ code: "BAD_REQUEST", message: "لا عدّ مسجّلاً لهذا الصنف بعد — لا حاجة لإعادة العدّ" });

    await tx
      .update(stocktakeItems)
      .set({
        recountStatus: "PENDING",
        recountReason: args.reason,
        recountRequestedBy: actor.userId,
        recountRequestedAt: new Date(),
      })
      .where(eq(stocktakeItems.id, Number(item.id)));

    // التعارض المفتوح يُحال للعدّ الثالث الحاسم (نمط jrd-review): يُغلق هنا ويتولّى RECOUNT الفصل.
    await tx
      .update(stocktakeCounts)
      .set({ isConflict: false })
      .where(
        and(
          eq(stocktakeCounts.sessionId, args.sessionId),
          eq(stocktakeCounts.variantId, args.variantId),
          eq(stocktakeCounts.isConflict, true),
          sql`${stocktakeCounts.resolvedPick} IS NULL`
        )
      );

    // قرار سابق على الصنف يسقط — سيُعاد بناؤه بعد العدّ الجديد.
    await tx
      .delete(stocktakeDecisions)
      .where(and(eq(stocktakeDecisions.sessionId, args.sessionId), eq(stocktakeDecisions.variantId, args.variantId)));

    // إعادة فتح تكليف الصنف والجلسة كي تقبل البوابة العدّ الجديد.
    await tx
      .update(stocktakeAssignments)
      .set({ status: "ACTIVE", submittedAt: null })
      .where(and(eq(stocktakeAssignments.id, Number(item.assignmentId)), eq(stocktakeAssignments.status, "SUBMITTED")));
    if (s.status === "REVIEW") {
      await tx
        .update(stocktakeSessions)
        // التوقيع الأول يُبطَل أيضاً: البيانات ستتغير بعد إعادة العدّ فلا يصح اعتماد نهائي على توقيع قديم.
        .set({ status: "COUNTING", submittedAt: null, firstSignBy: null, firstSignAt: null })
        .where(eq(stocktakeSessions.id, args.sessionId));
    }
    return { ok: true as const };
  });
}

/** إبطال التوقيع الأول عند أي تغيير لاحق في بيانات المراجعة (قرار/فصل تعارض) — لا اعتماد على توقيع لبيانات قديمة. */
async function invalidateFirstSign(tx: Tx, sessionId: number, firstSignBy: unknown): Promise<void> {
  if (firstSignBy == null) return;
  await tx
    .update(stocktakeSessions)
    .set({ firstSignBy: null, firstSignAt: null })
    .where(eq(stocktakeSessions.id, sessionId));
}

/** الفصل في تعارض عدَّين: اعتماد أحدهما (يبقى كلاهما موثَّقاً في السجل). */
export async function resolveStocktakeConflict(
  args: { sessionId: number; variantId: number; pick: "FIRST" | "VERIFY" },
  actor: StkActor
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الفصل في تعارض على جلسة معتمدة أو ملغاة" });
    }
    const open = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, args.sessionId),
            eq(stocktakeCounts.variantId, args.variantId),
            eq(stocktakeCounts.kind, "VERIFY"),
            eq(stocktakeCounts.isConflict, true),
            sql`${stocktakeCounts.resolvedPick} IS NULL`
          )
        )
        .orderBy(desc(stocktakeCounts.id))
        .limit(1)
    )[0];
    if (!open) throw new TRPCError({ code: "BAD_REQUEST", message: "لا تعارض مفتوحاً على هذا الصنف" });
    await tx
      .update(stocktakeCounts)
      .set({ resolvedPick: args.pick, resolvedBy: actor.userId, resolvedAt: new Date() })
      .where(eq(stocktakeCounts.id, Number(open.id)));
    await invalidateFirstSign(tx, args.sessionId, s.firstSignBy);
    return { ok: true as const };
  });
}

/** قرار مراجعة صريح (تسوية/إبقاء) — تُثبَّت قيمه النهائية عند الاعتماد. */
export async function decideStocktakeItem(
  args: {
    sessionId: number;
    variantId: number;
    action: "ADJUST" | "KEEP";
    reason: "UNSPECIFIED" | "DAMAGE" | "LOSS_THEFT" | "ENTRY_ERROR" | "PRINT_WASTE";
    note?: string;
  },
  actor: StkActor
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "القرارات تُتّخذ على جلسة قيد المراجعة فقط" });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    if (item.recountStatus === "PENDING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الصنف بانتظار إعادة العدّ — لا قرار قبل وصول العدّ الجديد" });
    }
    const hasCount = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(and(eq(stocktakeCounts.sessionId, args.sessionId), eq(stocktakeCounts.variantId, args.variantId)))
        .limit(1)
    )[0];
    if (!hasCount) throw new TRPCError({ code: "BAD_REQUEST", message: "لا عدّ مسجّلاً لهذا الصنف — لا يمكن اتخاذ قرار" });
    const openConflict = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, args.sessionId),
            eq(stocktakeCounts.variantId, args.variantId),
            eq(stocktakeCounts.isConflict, true),
            sql`${stocktakeCounts.resolvedPick} IS NULL`
          )
        )
        .limit(1)
    )[0];
    if (openConflict) throw new TRPCError({ code: "BAD_REQUEST", message: "افصل في تعارض العدَّين أولاً قبل القرار" });

    await tx
      .insert(stocktakeDecisions)
      .values({
        sessionId: args.sessionId,
        variantId: args.variantId,
        action: args.action,
        reason: args.reason,
        note: args.note ?? null,
        decidedBy: actor.userId,
        autoApplied: false,
      })
      .onDuplicateKeyUpdate({
        set: {
          action: args.action,
          reason: args.reason,
          note: args.note ?? null,
          decidedBy: actor.userId,
          autoApplied: false,
          decidedAt: new Date(),
        },
      });
    await invalidateFirstSign(tx, args.sessionId, s.firstSignBy);
    return { ok: true as const };
  });
}

/** التوقيع الأول (الاعتماد المزدوج): يُسجَّل فقط حين توجد فروقات ستُسوّى فوق dualThreshold. */
export async function firstSignStocktake(
  sessionId: number,
  actor: StkActor
): Promise<{ ok: true; firstSignByName: string; firstSignAt: Date }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "التوقيع الأول متاح على جلسة قيد المراجعة فقط" });
    }
    const me = (await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId)).limit(1))[0];
    const myName = me?.name ?? `#${actor.userId}`;
    if (s.firstSignBy != null) {
      if (Number(s.firstSignBy) === actor.userId) {
        return { ok: true as const, firstSignByName: myName, firstSignAt: s.firstSignAt ?? new Date() }; // idempotent
      }
      throw new TRPCError({ code: "CONFLICT", message: "وُقّع توقيع أول مسبقاً من مستخدم آخر" });
    }
    // أعد الحساب داخل المعاملة: التوقيع الأول لا معنى له بلا فرق سيُسوّى فوق حد التوقيعين.
    const { rows, directUnderThreshold } = await loadReviewCore(tx, sessionId, true);
    const needed = rows.some((r) => r.requiresDualSign && willAdjust(r, directUnderThreshold));
    if (!needed) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا فروقات تتجاوز حدّ التوقيعين — الاعتماد المباشر يكفي" });
    }
    const at = new Date();
    await tx.update(stocktakeSessions).set({ firstSignBy: actor.userId, firstSignAt: at }).where(eq(stocktakeSessions.id, sessionId));
    return { ok: true as const, firstSignByName: myName, firstSignAt: at };
  });
}

export interface ApproveResult {
  ok: true;
  alreadyApproved?: boolean;
  adjustedCount: number;
  shortExpense: string;
  overGain: string;
}

/**
 * الاعتماد والتسوية — الخوارزمية الذرّية (العقد §٢ «الاعتماد») خطوة خطوة داخل withTx واحدة:
 * idempotent على APPROVED، حواجز (recount/تعارض/قرارات)، توقيعان بمستخدمَين مختلفَين (تحقّق
 * خادمي بالمعرّف)، إعادة حساب كاملة داخل المعاملة، setStock حصراً بمرجع STOCKTAKE،
 * قرارات تلقائية (ADJUST ضمن الحد + KEEP للمطابق — يلزم لسجل IRA)، قيدا دفتر بـdedupeKey،
 * ثم lastCountedAt لكل معدود وختم الجلسة APPROVED.
 */
export async function approveStocktake(sessionId: number, actor: StkActor): Promise<ApproveResult> {
  return withTx(async (tx) => {
    // (١) قفل الجلسة. APPROVED ⇒ نجاح بلا أثر (idempotent — حماية النقر المزدوج/إعادة الشبكة).
    const s = await lockSession(tx, sessionId);
    if (s.status === "APPROVED") {
      return { ok: true as const, alreadyApproved: true, adjustedCount: 0, shortExpense: "0.00", overGain: "0.00" };
    }
    if (s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الاعتماد متاح على جلسة قيد المراجعة فقط" });
    }

    // (١.٥) قفل أرصدة أصناف الجلسة FOR UPDATE قبل إعادة الحساب — يسدّ سباق TOCTOU مع بيع
    // متزامن: بدونه يُحتسب bookNow/netAfter على لقطة، يلتزم بيعٌ أثناءها، ثم يكتب setStock
    // هدفاً مطلقاً محسوباً على القديم فيمحو أثر البيع من الرصيد. الترتيب تصاعدي بالـvariantId
    // (نفس ترتيب التسويات لاحقاً) لتقليل نوافذ deadlock مع معاملات متعددة الأسطر.
    const lockIds = (
      await tx
        .select({ variantId: stocktakeItems.variantId })
        .from(stocktakeItems)
        .where(eq(stocktakeItems.sessionId, sessionId))
        .orderBy(asc(stocktakeItems.variantId))
    ).map((r) => Number(r.variantId));
    for (const part of chunk(lockIds)) {
      await tx
        .select({ id: branchStock.id })
        .from(branchStock)
        .where(and(eq(branchStock.branchId, Number(s.branchId)), inArray(branchStock.variantId, part)))
        .orderBy(asc(branchStock.variantId))
        .for("update");
    }

    // (٤ قبل ٢) أعد الحساب داخل المعاملة — لا ثقة بحسابات شاشة المراجعة.
    const { rows, directUnderThreshold } = await loadReviewCore(tx, sessionId, true);

    // (٢) الحواجز.
    const pendingRecounts = rows.filter((r) => r.recount?.status === "PENDING");
    if (pendingRecounts.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `لا اعتماد و${pendingRecounts.length} صنفاً بانتظار إعادة العدّ`,
      });
    }
    const openConflicts = rows.filter((r) => r.openConflict);
    if (openConflicts.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `لا اعتماد ويوجد ${openConflicts.length} تعارض عدَّين بلا فصل`,
      });
    }
    const undecided = rows.filter((r) => {
      if (r.diff == null || r.diff === 0 || r.decision) return false;
      return r.overThreshold || !directUnderThreshold;
    });
    if (undecided.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `${undecided.length} فرقاً يحتاج قراراً صريحاً (تسوية/إبقاء) قبل الاعتماد`,
      });
    }

    // (٣) التوقيعان: عنصر سيُسوّى |قيمته| > dualThreshold ⇒ توقيع أول موجود + المعتمد شخص مختلف.
    const dualNeeded = rows.some((r) => r.requiresDualSign && willAdjust(r, directUnderThreshold));
    if (dualNeeded) {
      if (s.firstSignBy == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "فروقات تتجاوز حدّ التوقيعين — يلزم توقيع أول ثم اعتماد نهائي من مسؤول آخر",
        });
      }
      if (Number(s.firstSignBy) === actor.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "وقّعتَ التوقيع الأول — الاعتماد النهائي يلزم أن يكون من مسؤول آخر",
        });
      }
    }

    const now = new Date();

    // (٤+٥) التسويات والقرارات النهائية.
    let adjustedMovements = 0;
    let shortExpense = money(0);
    let overGain = money(0);
    type DecisionUpsert = typeof stocktakeDecisions.$inferInsert;
    const upserts: DecisionUpsert[] = [];

    for (const r of rows) {
      if (r.rawCount == null || r.adjustedCount == null || r.diff == null) continue; // غير معدود ⇒ يبقى دفترياً بلا قرار

      let action: "ADJUST" | "KEEP";
      let decidedBy: number | null;
      let autoApplied: boolean;
      let reason: DecisionUpsert["reason"];
      let note: string | null;
      if (r.diff === 0) {
        // مطابق ⇒ KEEP تلقائي (يلزم لسجل IRA والمحضر). قرار صريح سابق يتحوّل KEEP بقيم نهائية.
        action = "KEEP";
        decidedBy = r.decision && !r.decision.autoApplied ? r.decidedBy : null;
        autoApplied = !(r.decision && !r.decision.autoApplied);
        reason = (r.decision?.reason as DecisionUpsert["reason"]) ?? "UNSPECIFIED";
        note = r.decision?.note ?? null;
      } else if (r.decision) {
        action = r.decision.action;
        decidedBy = r.decidedBy;
        autoApplied = r.decision.autoApplied;
        reason = r.decision.reason as DecisionUpsert["reason"];
        note = r.decision.note ?? null;
      } else if (r.withinThreshold && directUnderThreshold) {
        // (٥) ضمن الحد بلا قرار ⇒ تسوية تلقائية.
        action = "ADJUST";
        decidedBy = null;
        autoApplied = true;
        reason = "UNSPECIFIED";
        note = null;
      } else {
        // مستحيل منطقياً بعد حاجز undecided — حارس دفاعي.
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "حالة قرار غير متوقعة أثناء الاعتماد" });
      }

      if (action === "ADJUST" && r.diff !== 0) {
        if (r.adjustedCount < 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `العدّ المصحَّح سالب للصنف «${r.productName}» — راجع الحركات اللاحقة قبل الاعتماد`,
          });
        }
        await setStock(tx, {
          variantId: r.variantId,
          branchId: Number(s.branchId),
          targetQuantity: r.adjustedCount,
          referenceType: "STOCKTAKE",
          referenceId: sessionId,
          notes: s.code,
          createdBy: actor.userId,
        });
        adjustedMovements++;
        const v = money(r.value ?? 0);
        if (r.diff < 0) shortExpense = shortExpense.plus(v.abs());
        else overGain = overGain.plus(v);
      }

      upserts.push({
        sessionId,
        variantId: r.variantId,
        action,
        finalQty: r.adjustedCount,
        diffQty: r.diff,
        value: toDbMoney(money(r.value ?? 0)),
        reason,
        note,
        decidedBy,
        autoApplied,
      });
    }

    // تثبيت كل القرارات بقيمها النهائية (upsert مجمّع على UNIQUE(sessionId, variantId)).
    for (const part of chunk(upserts, 500)) {
      await tx
        .insert(stocktakeDecisions)
        .values(part)
        .onDuplicateKeyUpdate({
          set: {
            action: sql.raw("VALUES(`action`)"),
            finalQty: sql.raw("VALUES(`finalQty`)"),
            diffQty: sql.raw("VALUES(`diffQty`)"),
            value: sql.raw("VALUES(`value`)"),
            reason: sql.raw("VALUES(`reason`)"),
            note: sql.raw("VALUES(`note`)"),
            decidedBy: sql.raw("VALUES(`decidedBy`)"),
            autoApplied: sql.raw("VALUES(`autoApplied`)"),
          },
        });
    }

    // (٦) القيدان المحاسبيان — قرار التقارير (مفحوص في reportsRouter/reportsService/reconcileService):
    //   - تقارير الربح والمبيعات (salesReport/topProducts/profitByCategory) تُشتق من invoices/invoiceItems
    //     لا من accountingEntries ⇒ قيد ADJUST لا يمسّ المبيعات إطلاقاً.
    //   - الصندوق/الوردية يُشتقان من receipts ⇒ amount=0 لا يلمس الصندوق.
    //   - reconcileLedgerProfit يفرض profit = revenue − cost على كل قيد ⇒ نكتب profit = −cost:
    //     عجز: cost موجب ⇒ profit سالب (ينخفض الربح بقيمة العجز)؛
    //     زيادة: cost سالب ⇒ profit موجب (يرتفع الربح بقيمة الزيادة). dedupeKey يمنع الازدواج بنيوياً.
    if (shortExpense.gt(0)) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(s.branchId),
        cost: shortExpense,
        profit: shortExpense.neg(),
        amount: money(0),
        notes: `جرد ${s.code} — عجز مخزون`,
        dedupeKey: `STOCKTAKE:${sessionId}:SHORT`,
        entryDate: now,
      });
    }
    if (overGain.gt(0)) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(s.branchId),
        cost: overGain.neg(),
        profit: overGain,
        amount: money(0),
        notes: `جرد ${s.code} — زيادة جرد`,
        dedupeKey: `STOCKTAKE:${sessionId}:OVER`,
        entryDate: now,
      });
    }

    // (٧) آخر جرد معتمد لكل صنف معدود — يغذي «آخر جرد» والجرد الدوري ABC.
    // upsert لا UPDATE: صنف عُدّ صفراً بلا صفّ branchStock يبقى بلا صفّ فيظلّ «لم يُجرد» زوراً.
    const countedVariantIds = rows.filter((r) => r.rawCount != null).map((r) => r.variantId);
    for (const part of chunk(countedVariantIds)) {
      if (!part.length) continue;
      await tx
        .insert(branchStock)
        .values(part.map((v) => ({ variantId: v, branchId: Number(s.branchId), quantity: 0, lastCountedAt: now })))
        .onDuplicateKeyUpdate({ set: { lastCountedAt: now } });
    }

    // (٨) ختم الجلسة.
    await tx
      .update(stocktakeSessions)
      .set({ status: "APPROVED", approvedBy: actor.userId, approvedAt: now })
      .where(eq(stocktakeSessions.id, sessionId));

    return {
      ok: true as const,
      adjustedCount: adjustedMovements,
      shortExpense: toDbMoney(shortExpense),
      overGain: toDbMoney(overGain),
    };
  });
}

/** إقفال العدّ يدوياً: كل التكليفات ACTIVE ⇒ SUBMITTED والجلسة ⇒ REVIEW (مراجعة جزئية مسموحة). */
export async function forceStocktakeReview(sessionId: number, _actor: StkActor): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.status === "REVIEW") return { ok: true as const }; // idempotent
    if (s.status !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "إقفال العدّ متاح على جلسة قيد العدّ فقط" });
    }
    const now = new Date();
    await tx
      .update(stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: now })
      .where(and(eq(stocktakeAssignments.sessionId, sessionId), eq(stocktakeAssignments.status, "ACTIVE")));
    await tx.update(stocktakeSessions).set({ status: "REVIEW", submittedAt: now }).where(eq(stocktakeSessions.id, sessionId));
    return { ok: true as const };
  });
}

/** إلغاء جلسة (أدمن): لا أثر مخزونياً — الجلسة لم تُسوَّ بعد. المعتمدة لا تُلغى. */
export async function cancelStocktakeSession(
  args: { sessionId: number; reason?: string },
  actor: StkActor
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status === "CANCELLED") return { ok: true as const }; // idempotent
    if (s.status === "APPROVED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء جلسة معتمدة — التسوية نُفّذت فعلاً" });
    }
    const notes = args.reason?.trim()
      ? `${s.notes ? `${s.notes}\n` : ""}سبب الإلغاء: ${args.reason.trim()}`
      : s.notes;
    await tx
      .update(stocktakeSessions)
      .set({ status: "CANCELLED", cancelledBy: actor.userId, cancelledAt: new Date(), notes })
      .where(eq(stocktakeSessions.id, args.sessionId));
    return { ok: true as const };
  });
}

/** إعادة توليد PIN لتكليف خارجي: يُصفِّر قفل المحاولات ويعيد النص مرة واحدة فقط. */
export async function regenerateStocktakePin(
  assignmentId: number,
  opts: { restrictBranchId?: number | null } = {}
): Promise<{ pin: string }> {
  return withTx(async (tx) => {
    const rows = await tx
      .select({
        id: stocktakeAssignments.id,
        sessionId: stocktakeAssignments.sessionId,
        method: stocktakeAssignments.method,
        sessionStatus: stocktakeSessions.status,
        branchId: stocktakeSessions.branchId,
      })
      .from(stocktakeAssignments)
      .innerJoin(stocktakeSessions, eq(stocktakeAssignments.sessionId, stocktakeSessions.id))
      .where(eq(stocktakeAssignments.id, assignmentId))
      .for("update")
      .limit(1);
    const a = rows[0];
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "تكليف الجرد غير موجود" });
    assertBranchAccess(Number(a.branchId), opts.restrictBranchId);
    if (a.method !== "PIN") throw new TRPCError({ code: "BAD_REQUEST", message: "هذا التكليف بحساب داخلي — لا PIN له" });
    if (a.sessionStatus !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "إعادة توليد PIN متاحة أثناء العدّ فقط" });
    }

    // فرادة PIN داخل الجلسة: لا نملك النصوص (hash فقط) ⇒ نتحقق بـverifyPassword ضد بقية التكليفات.
    const siblings = await tx
      .select({ id: stocktakeAssignments.id, pinHash: stocktakeAssignments.pinHash })
      .from(stocktakeAssignments)
      .where(and(eq(stocktakeAssignments.sessionId, Number(a.sessionId)), eq(stocktakeAssignments.method, "PIN")));
    let pin = "";
    outer: for (let i = 0; i < 100; i++) {
      pin = String(randomInt(0, 10000)).padStart(4, "0");
      for (const sib of siblings) {
        if (Number(sib.id) !== assignmentId && sib.pinHash && verifyPassword(pin, sib.pinHash)) continue outer;
      }
      break;
    }
    if (!pin) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر توليد رمز PIN فريد" });

    await tx
      .update(stocktakeAssignments)
      .set({ pinHash: hashPassword(pin), failedPinAttempts: 0, lockedUntil: null })
      .where(eq(stocktakeAssignments.id, assignmentId));
    return { pin };
  });
}

/* ============================ الذكاء التشغيلي: ABC دوري + IRA ============================ */

export interface CycleSuggestionRow {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  abc: "A" | "B" | "C";
  freqDays: number;
  freqLabel: string;
  lastCountedAt: Date | null;
  /** أيام التأخر عن الدورية؛ null = لم يُجرد قط (الأكثر استحقاقاً). */
  daysOver: number | null;
  /** قيمة الاستهلاك السنوية (OUT×التكلفة) — تُحجب عن دور warehouse في الراوتر. */
  annualValue: string;
}

/**
 * اقتراحات الجرد الدوري ABC: قيمة استهلاك OUT آخر ٣٦٥ يوماً × costPrice، ترتيب تنازلي،
 * أول ٢٠٪ من الأصناف A (شهرياً) وثاني ٣٠٪ B (فصلياً) والباقي C (نصف سنوياً).
 * المستحق: lastCountedAt أقدم من الدورية أو NULL.
 */
export async function getCycleSuggestions(opts: { branchId?: number | null } = {}): Promise<CycleSuggestionRow[]> {
  const db = requireDb();
  const branchId = opts.branchId ?? null;
  const since = new Date(Date.now() - 365 * 86_400_000);

  // (١) كل المتغيّرات الفعّالة بأسمائها وتكلفتها.
  const variants = await db
    .select({
      variantId: productVariants.id,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      costPrice: productVariants.costPrice,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(eq(productVariants.isActive, true), eq(products.isActive, true)));

  // (٢) استهلاك OUT آخر سنة (مجمّع — لا N+1).
  const outConds = [eq(inventoryMovements.movementType, "OUT"), gte(inventoryMovements.createdAt, since)];
  if (branchId != null) outConds.push(eq(inventoryMovements.branchId, branchId));
  const outRows = await db
    .select({ variantId: inventoryMovements.variantId, q: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)` })
    .from(inventoryMovements)
    .where(and(...outConds))
    .groupBy(inventoryMovements.variantId);
  const outMap = new Map(outRows.map((r) => [Number(r.variantId), String(r.q ?? "0")]));

  // (٣) آخر جرد معتمد لكل متغيّر (فرع محدد، أو الأحدث عبر الفروع).
  const lcConds = branchId != null ? [eq(branchStock.branchId, branchId)] : [];
  const lcRows = await db
    .select({ variantId: branchStock.variantId, last: sql<Date | null>`MAX(${branchStock.lastCountedAt})` })
    .from(branchStock)
    .where(lcConds.length ? and(...lcConds) : undefined)
    .groupBy(branchStock.variantId);
  const lastMap = new Map(lcRows.map((r) => [Number(r.variantId), r.last]));

  // ترتيب تنازلي بقيمة الاستهلاك ثم تصنيف بالعدد: أول ٢٠٪ A، ثاني ٣٠٪ B، الباقي C.
  const valued = variants.map((v) => ({
    variantId: Number(v.variantId),
    productName: String(v.productName ?? ""),
    variantName: v.variantName,
    sku: v.sku,
    annualValue: money(outMap.get(Number(v.variantId)) ?? 0).times(money(String(v.costPrice ?? "0"))),
  }));
  valued.sort((a, b) => b.annualValue.comparedTo(a.annualValue));
  const n = valued.length;
  const aCut = Math.ceil(n * 0.2);
  const bCut = Math.ceil(n * 0.5);

  const now = Date.now();
  const out: CycleSuggestionRow[] = [];
  valued.forEach((v, idx) => {
    const abc: "A" | "B" | "C" = idx < aCut ? "A" : idx < bCut ? "B" : "C";
    const freqDays = ABC_FREQ_DAYS[abc];
    const lastRaw = lastMap.get(v.variantId) ?? null;
    const last = lastRaw ? new Date(lastRaw) : null;
    const days = last ? Math.floor((now - last.getTime()) / 86_400_000) : null;
    const due = days == null ? true : days > freqDays;
    if (!due) return;
    out.push({
      variantId: v.variantId,
      productName: v.productName,
      variantName: v.variantName,
      sku: v.sku,
      abc,
      freqDays,
      freqLabel: ABC_FREQ_LABEL[abc],
      lastCountedAt: last,
      daysOver: days == null ? null : days - freqDays,
      annualValue: toDbMoney(v.annualValue),
    });
  });
  // الأكثر تأخراً أولاً؛ «لم يُجرد قط» في الصدارة.
  out.sort((a, b) => (b.daysOver ?? Number.MAX_SAFE_INTEGER) - (a.daysOver ?? Number.MAX_SAFE_INTEGER));
  return out;
}

export interface IraStatsResult {
  branches: { branchId: number; name: string; months: { ym: string; ira: number | null }[] }[];
  workers: { name: string; accuracy: number; counts: number }[];
}

/**
 * مؤشر دقة المخزون IRA — من الجلسات المعتمدة فعلياً:
 * شهرياً (آخر ٦ أشهر) لكل فرع: matched/counted من stocktakeDecisions.diffQty=0،
 * ودقة كل عامل بإسناد كل صنف معدود لصاحب العدّ الفعّال (RECOUNT الأحدث وإلا FIRST/فصل التعارض).
 */
export async function getIraStats(): Promise<IraStatsResult> {
  const db = requireDb();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  monthStart.setMonth(monthStart.getMonth() - 5);

  const sessions = await db
    .select({
      id: stocktakeSessions.id,
      branchId: stocktakeSessions.branchId,
      branchName: branches.name,
      approvedAt: stocktakeSessions.approvedAt,
    })
    .from(stocktakeSessions)
    .leftJoin(branches, eq(stocktakeSessions.branchId, branches.id))
    .where(and(eq(stocktakeSessions.status, "APPROVED"), gte(stocktakeSessions.approvedAt, monthStart)));

  const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const months: string[] = [];
  {
    const cur = new Date(monthStart);
    for (let i = 0; i < 6; i++) {
      months.push(ymOf(cur));
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  const sessionIds = sessions.map((r) => Number(r.id));
  const sessionMeta = new Map(
    sessions.map((r) => [
      Number(r.id),
      { branchId: Number(r.branchId), branchName: r.branchName ?? "—", ym: r.approvedAt ? ymOf(new Date(r.approvedAt)) : null },
    ])
  );

  type Agg = { matched: number; counted: number };
  const branchMonthly = new Map<number, { name: string; byYm: Map<string, Agg> }>();
  const workerAgg = new Map<string, Agg>();

  if (sessionIds.length) {
    const decisions = await db
      .select({ sessionId: stocktakeDecisions.sessionId, variantId: stocktakeDecisions.variantId, diffQty: stocktakeDecisions.diffQty })
      .from(stocktakeDecisions)
      .where(inArray(stocktakeDecisions.sessionId, sessionIds));

    const counts = await db
      .select({
        sessionId: stocktakeCounts.sessionId,
        variantId: stocktakeCounts.variantId,
        kind: stocktakeCounts.kind,
        countedByName: stocktakeCounts.countedByName,
        countedAt: stocktakeCounts.countedAt,
        id: stocktakeCounts.id,
        isConflict: stocktakeCounts.isConflict,
        resolvedPick: stocktakeCounts.resolvedPick,
      })
      .from(stocktakeCounts)
      .where(inArray(stocktakeCounts.sessionId, sessionIds))
      .orderBy(asc(stocktakeCounts.countedAt), asc(stocktakeCounts.id));

    // صاحب العدّ الفعّال لكل (جلسة×صنف) — نفس قاعدة rawCount في المراجعة.
    const effOwner = new Map<string, string>();
    {
      const grouped = new Map<string, typeof counts>();
      for (const c of counts) {
        const k = `${Number(c.sessionId)}:${Number(c.variantId)}`;
        const list = grouped.get(k) ?? [];
        list.push(c);
        grouped.set(k, list);
      }
      for (const [k, list] of Array.from(grouped.entries())) {
        const firsts = list.filter((c) => c.kind === "FIRST");
        const recounts = list.filter((c) => c.kind === "RECOUNT");
        const verifies = list.filter((c) => c.kind === "VERIFY");
        const first = firsts[firsts.length - 1];
        const recount = recounts[recounts.length - 1];
        const verify = verifies[verifies.length - 1];
        let owner: string | undefined;
        if (recount) owner = recount.countedByName;
        else if (first) {
          owner = verify && verify.isConflict && verify.resolvedPick === "VERIFY" ? verify.countedByName : first.countedByName;
        }
        if (owner) effOwner.set(k, owner);
      }
    }

    for (const d of decisions) {
      const meta = sessionMeta.get(Number(d.sessionId));
      if (!meta || !meta.ym) continue;
      const matched = d.diffQty === 0 ? 1 : 0;

      let bm = branchMonthly.get(meta.branchId);
      if (!bm) {
        bm = { name: meta.branchName, byYm: new Map() };
        branchMonthly.set(meta.branchId, bm);
      }
      const agg = bm.byYm.get(meta.ym) ?? { matched: 0, counted: 0 };
      agg.matched += matched;
      agg.counted += 1;
      bm.byYm.set(meta.ym, agg);

      const owner = effOwner.get(`${Number(d.sessionId)}:${Number(d.variantId)}`);
      if (owner) {
        const w = workerAgg.get(owner) ?? { matched: 0, counted: 0 };
        w.matched += matched;
        w.counted += 1;
        workerAgg.set(owner, w);
      }
    }
  }

  // كل الفروع الفعّالة تظهر (حتى بلا بيانات — ira=null) ليكتمل اتجاه البطاقة.
  const allBranches = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(eq(branches.isActive, true))
    .orderBy(asc(branches.id));

  return {
    branches: allBranches.map((b) => {
      const bm = branchMonthly.get(Number(b.id));
      return {
        branchId: Number(b.id),
        name: b.name,
        months: months.map((ym) => {
          const agg = bm?.byYm.get(ym);
          const ira =
            agg && agg.counted > 0
              ? money(agg.matched).div(agg.counted).times(100).toDecimalPlaces(1).toNumber()
              : null;
          return { ym, ira };
        }),
      };
    }),
    workers: Array.from(workerAgg.entries())
      .map(([name, w]) => ({
        name,
        accuracy: w.counted > 0 ? money(w.matched).div(w.counted).times(100).toDecimalPlaces(1).toNumber() : 0,
        counts: w.counted,
      }))
      .sort((a, b) => b.accuracy - a.accuracy),
  };
}

/** عدّادات بطاقة لوحة التحكم/القائمة. */
export async function getStocktakeStats(opts: { restrictBranchId?: number | null } = {}) {
  const db = requireDb();
  const conds = (status: "COUNTING" | "REVIEW") => {
    const cs = [eq(stocktakeSessions.status, status)];
    if (opts.restrictBranchId != null) cs.push(eq(stocktakeSessions.branchId, opts.restrictBranchId));
    return and(...cs);
  };
  const countingRow = (await db.select({ c: sql<number>`COUNT(*)` }).from(stocktakeSessions).where(conds("COUNTING")))[0];
  const reviewRow = (await db.select({ c: sql<number>`COUNT(*)` }).from(stocktakeSessions).where(conds("REVIEW")))[0];
  return { counting: Number(countingRow?.c ?? 0), review: Number(reviewRow?.c ?? 0) };
}

/* ============================ المحضر النهائي وقوائم العدّ ============================ */

/**
 * بيانات المحضر النهائي. للجلسة المعتمدة المرجع هو «القرارات المثبَّتة» (finalQty/diffQty/value
 * كُتبت لحظة الاعتماد) لا إعادة الحساب الحيّ — لأن التسوية نفسها صفّرت الفروق الحيّة بعد التنفيذ.
 */
export async function getStocktakeReport(sessionId: number) {
  const db = requireDb();
  const { s, rows, directUnderThreshold } = await loadReviewCore(db, sessionId, true);
  const approved = s.status === "APPROVED";

  // قرارات مخزّنة (المرجع بعد الاعتماد).
  const stored = await db
    .select({
      variantId: stocktakeDecisions.variantId,
      action: stocktakeDecisions.action,
      finalQty: stocktakeDecisions.finalQty,
      diffQty: stocktakeDecisions.diffQty,
      value: stocktakeDecisions.value,
      reason: stocktakeDecisions.reason,
      note: stocktakeDecisions.note,
      autoApplied: stocktakeDecisions.autoApplied,
      decidedByName: users.name,
      decidedBy: stocktakeDecisions.decidedBy,
    })
    .from(stocktakeDecisions)
    .leftJoin(users, eq(stocktakeDecisions.decidedBy, users.id))
    .where(eq(stocktakeDecisions.sessionId, sessionId));
  const storedMap = new Map(stored.map((d) => [Number(d.variantId), d]));

  const reportRows = rows.map(({ decidedBy: _db2, openConflict: _oc, ...r }) => {
    const d = storedMap.get(r.variantId);
    if (approved && d) {
      // قيم لحظة الاعتماد هي الحقيقة التاريخية للمحضر.
      return {
        ...r,
        adjustedCount: d.finalQty ?? r.adjustedCount,
        diff: d.diffQty ?? r.diff,
        value: d.value == null ? r.value : String(d.value),
        decision: {
          action: d.action,
          reason: d.reason,
          note: d.note,
          decidedByName: d.decidedBy == null ? null : (d.decidedByName ?? "—"),
          autoApplied: !!d.autoApplied,
        },
      };
    }
    return r;
  });

  // إجماليات المحضر: من القيم المعروضة نفسها (المخزّنة للمعتمدة، الحيّة للمعاينة).
  let counted = 0;
  let matched = 0;
  let over = 0;
  let short = 0;
  let netValue = money(0);
  let shortValue = money(0);
  let overValue = money(0);
  for (const r of reportRows) {
    if (r.diff == null) continue;
    counted++;
    const v = money(r.value ?? 0);
    if (r.diff === 0) matched++;
    else if (r.diff > 0) {
      over++;
      overValue = overValue.plus(v);
    } else {
      short++;
      shortValue = shortValue.plus(v);
    }
    netValue = netValue.plus(v);
  }

  // تحليل الانكماش حسب السبب: التسويات المنفَّذة فقط (action=ADJUST و diff≠0).
  const shrinkMap = new Map<string, { count: number; value: Decimal }>();
  for (const r of reportRows) {
    if (!r.decision || r.decision.action !== "ADJUST" || r.diff == null || r.diff === 0) continue;
    const key = r.decision.reason;
    const agg = shrinkMap.get(key) ?? { count: 0, value: money(0) };
    agg.count += 1;
    agg.value = agg.value.plus(money(r.value ?? 0));
    shrinkMap.set(key, agg);
  }

  // قيد الدفتر: عجز/زيادة المسوّى فعلاً (يطابق dedupeKey STOCKTAKE:<id>:SHORT/:OVER).
  let shortExpense = money(0);
  let overGain = money(0);
  for (const r of reportRows) {
    const adjusted = r.decision ? r.decision.action === "ADJUST" : !approved && willAdjust(r as unknown as ReviewRow, directUnderThreshold);
    if (!adjusted || r.diff == null || r.diff === 0) continue;
    const v = money(r.value ?? 0);
    if (r.diff < 0) shortExpense = shortExpense.plus(v.abs());
    else overGain = overGain.plus(v);
  }

  return {
    session: buildReviewSession(s),
    rows: reportRows,
    totals: {
      total: reportRows.length,
      counted,
      matched,
      over,
      short,
      netValue: toDbMoney(netValue),
      shortValue: toDbMoney(shortValue),
      overValue: toDbMoney(overValue),
    },
    shrinkage: Array.from(shrinkMap.entries()).map(([reason, agg]) => ({
      reason,
      count: agg.count,
      value: toDbMoney(agg.value),
    })),
    ledger: { shortExpense: toDbMoney(shortExpense), overGain: toDbMoney(overGain) },
  };
}

/** قوائم العدّ الورقية — عمياء بالكامل: صنف/باركود/وحدة فقط، بلا expectedQty ولا تكلفة. */
export async function getStocktakeCountSheets(sessionId: number, opts: { restrictBranchId?: number | null } = {}) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);

  const asg = await db
    .select({
      id: stocktakeAssignments.id,
      name: stocktakeAssignments.name,
      method: stocktakeAssignments.method,
      zone: stocktakeAssignments.zone,
    })
    .from(stocktakeAssignments)
    .where(eq(stocktakeAssignments.sessionId, sessionId))
    .orderBy(asc(stocktakeAssignments.id));

  const itemRows = await db
    .select({
      assignmentId: stocktakeItems.assignmentId,
      variantId: stocktakeItems.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      barcode: productUnits.barcode,
      baseUnit: productUnits.unitName,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, and(eq(productUnits.variantId, stocktakeItems.variantId), eq(productUnits.isBaseUnit, true)))
    .where(eq(stocktakeItems.sessionId, sessionId))
    .orderBy(asc(products.name), asc(productVariants.id));

  const byAssignment = new Map<number, { productName: string; variantName: string | null; sku: string; barcode: string | null; baseUnit: string | null }[]>();
  const dedup = new Set<number>();
  for (const r of itemRows) {
    const v = Number(r.variantId);
    if (dedup.has(v)) continue; // ازدواج محتمل من join وحدات الأساس
    dedup.add(v);
    const aId = Number(r.assignmentId);
    const list = byAssignment.get(aId) ?? [];
    list.push({
      productName: String(r.productName ?? ""),
      variantName: r.variantName,
      sku: r.sku,
      barcode: r.barcode,
      baseUnit: r.baseUnit,
    });
    byAssignment.set(aId, list);
  }

  return {
    session: {
      id: Number(s.id),
      code: s.code,
      name: s.name,
      branchName: s.branchName ?? "—",
      blind: !!s.blind,
      status: s.status,
      createdAt: s.createdAt,
      createdByName: s.createdByName ?? "—",
    },
    sheets: asg.map((a) => ({
      assignment: { id: Number(a.id), name: a.name, method: a.method, zone: a.zone },
      items: byAssignment.get(Number(a.id)) ?? [],
    })),
  };
}
