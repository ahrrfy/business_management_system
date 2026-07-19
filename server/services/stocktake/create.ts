// إنشاء جلسة الجرد: حلّ النطاق + اللقطة الذرّية للرصيد والتكلفة + التكليفات (PIN crypto) + التوزيع.
import { TRPCError } from "@trpc/server";
import { randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, like } from "drizzle-orm";
import { mysqlCodeFrom } from "../../../shared/errorMap.ar";
import {
  branches,
  branchStock,
  categories,
  inventoryMovements,
  openingModeSettings,
  products,
  productVariants,
  stocktakeAssignments,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { hashPassword } from "../../auth/password";
import { toDbMoney } from "../money";
import { withTx } from "../tx";
import { extractInsertId } from "../../lib/insertId";
import type { StkActor } from "./types";
import { chunk } from "./internal";

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
  /** NORMAL (افتراضي) = جرد دوري؛ OPENING = «جرد افتتاحي» (مدير فأعلى + نافذة وضع الافتتاح فعّالة). */
  sessionType?: "NORMAL" | "OPENING";
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
  // gstack B7 (٧/٧/٢٦): البكجات بلا branchStock ⇒ حاجز setStock في finalize يرفضها فيُسقط اعتماد
  // الجرد كاملاً ذرّياً. نستبعدها من كل النطاقات هنا (نقطة الدخول الوحيدة) — البكج «يُجرَد» عبر
  // مكوّناته لا كوحدة قائمة بذاتها.
  const notBundleCond = eq(products.isBundle, false);

  if (input.scopeType === "FULL") {
    const rows = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(eq(productVariants.isActive, true), eq(products.isActive, true), notBundleCond));
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
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(inventoryMovements.branchId, input.branchId),
          gte(inventoryMovements.createdAt, since),
          eq(productVariants.isActive, true),
          notBundleCond
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
      .where(and(inArray(products.categoryId, catIds), eq(productVariants.isActive, true), eq(products.isActive, true), notBundleCond));
    const ids = rows.map((r) => Number(r.id));
    const names = catRows.map((c) => c.name).join("، ");
    return { variantIds: ids, label: `فئة: ${names} (${ids.length} صنفاً)`, detail: { categoryIds: catIds } };
  }

  // MANUAL
  const wanted = Array.from(new Set(input.variantIds ?? []));
  if (!wanted.length) throw new TRPCError({ code: "BAD_REQUEST", message: "اختر صنفاً واحداً على الأقل لنطاق الجرد" });
  const found = await (async () => {
    const out: Array<{ id: number; isBundle: boolean; productName: string; sku: string }> = [];
    for (const part of chunk(wanted)) {
      const rows = await tx
        .select({ id: productVariants.id, isBundle: products.isBundle, productName: products.name, sku: productVariants.sku })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, part));
      out.push(...rows.map((r) => ({ id: Number(r.id), isBundle: !!r.isBundle, productName: r.productName, sku: r.sku })));
    }
    return out;
  })();
  if (found.length !== wanted.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "بعض الأصناف المختارة غير موجودة في النظام" });
  }
  // gstack B7: رفض صريح لو كانت الأصناف المختارة يدوياً تحوي بكجاً — رسالة تسمّي المخالف.
  const bundleHit = found.find((f) => f.isBundle);
  if (bundleHit) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `لا يُجرَد بكج مباشرةً: «${bundleHit.productName} — ${bundleHit.sku}». اجرد مكوّناته فرادى.`,
    });
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

type StkScope = Awaited<ReturnType<typeof resolveScope>>;

async function createSessionInTx(tx: Tx, input: CreateStocktakeInput, actor: StkActor): Promise<CreateStocktakeResult> {
  const sessionType = input.sessionType ?? "NORMAL";

  // الفرع موجود — FOR UPDATE يسلسل إنشاء الجلسات لنفس الفرع ⇒ حارس الحصر المتبادل أدناه بلا سباق
  // (إنشاءان متزامنان لولا القفل يمرّان كلاهما من فحص «لا جلسة نشطة»).
  const br = (
    await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).for("update").limit(1)
  )[0];
  if (!br) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });

  // ── حوكمة «الجرد الافتتاحي» (مراجعة عدائية ١٨/٧) ──
  if (sessionType === "OPENING") {
    // (أ) مدير فأعلى: نوع الجلسة قرار حوكمي (يلغي العتبات الصنفية ويتخطى قيدَي العجز/الزيادة) —
    // لا يُترك لأمين المخزن وإن كان إنشاء الجرد الدوري من صلاحياته.
    if (actor.role !== "admin" && actor.role !== "manager") {
      throw new TRPCError({ code: "FORBIDDEN", message: "إنشاء جلسة جرد افتتاحي محصور بمدير فأعلى" });
    }
    // (ب) النافذة فعّالة: بلا هذا الشرط تبقى جلسات OPENING قناة تسويةٍ دائمة بلا أثر P&L بعد الإطلاق.
    const om = (await tx.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1))[0];
    const windowActive = !!om?.enabled && om.endsAt != null && om.endsAt.getTime() > Date.now();
    if (!windowActive) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "وضع الافتتاح غير فعّال — الجرد الافتتاحي محصور بنافذته (فعِّله من الإعدادات أولاً)",
      });
    }
  }

  // (ج) الحصر المتبادل لكل الفرع: جلسة OPENING لا تُنشأ وثمة أي جلسة نشطة، ولا تُنشأ أي جلسة
  // وثمة OPENING نشطة — تداخل NORMAL+OPENING على صنف يسرّب تسوية الافتتاح إلى netAfter للجلسة
  // الأخرى فيرحَّل «زيادة جرد» وهمية لقائمة الدخل (سيناريو رقمي مثبَت في المراجعة العدائية).
  const activeSessions = await tx
    .select({ id: stocktakeSessions.id, code: stocktakeSessions.code, sessionType: stocktakeSessions.sessionType })
    .from(stocktakeSessions)
    .where(and(eq(stocktakeSessions.branchId, input.branchId), inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"])));
  if (sessionType === "OPENING" && activeSessions.length) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `توجد جلسة جرد نشطة على الفرع (${activeSessions[0].code}) — اعتمدها أو ألغِها قبل بدء جرد افتتاحي`,
    });
  }
  const activeOpening = activeSessions.find((a) => a.sessionType === "OPENING");
  if (sessionType === "NORMAL" && activeOpening) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `جلسة جرد افتتاحي نشطة على الفرع (${activeOpening.code}) — اعتمدها أو ألغِها قبل جردٍ آخر`,
    });
  }

  // النطاق.
  const scope = await resolveScope(tx, input);

  // (د) الافتتاح مرّة واحدة لكل (صنف×فرع): الصنف المُفتتَح (openedAt ≠ NULL) لا يدخل جلسة OPENING —
  // إعادة افتتاحه = إعادة تأسيس رصيده بلا أي قيد دفتري (باب محو عجز حقيقي). يُجرَد دورياً بكامل قيوده.
  if (sessionType === "OPENING") {
    const openedSet = new Set<number>();
    for (const part of chunk(scope.variantIds)) {
      const rows = await tx
        .select({ variantId: branchStock.variantId })
        .from(branchStock)
        .where(
          and(
            eq(branchStock.branchId, input.branchId),
            inArray(branchStock.variantId, part),
            isNotNull(branchStock.openedAt),
          ),
        );
      for (const r of rows) openedSet.add(Number(r.variantId));
    }
    if (openedSet.size) {
      if (input.scopeType === "MANUAL") {
        // اختيار يدوي صريح لصنف مُفتتَح ⇒ رفض ناطق لا استبعاد صامت (المستخدم سمّاه قصداً).
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${openedSet.size} من الأصناف المختارة سبق افتتاحها — تُجرَد جرداً دورياً لا افتتاحياً`,
        });
      }
      scope.variantIds = scope.variantIds.filter((v) => !openedSet.has(v));
      scope.label = `${scope.label} — استُبعد ${openedSet.size} صنفاً مُفتتَحاً`;
    }
  }

  if (!scope.variantIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        sessionType === "OPENING"
          ? "كل أصناف النطاق مُفتتَحة مسبقاً — لا شيء يُجرَد افتتاحياً"
          : "نطاق الجرد لا يحوي أي صنف — راجع النطاق المحدد",
    });
  }
  const scopeSet = new Set(scope.variantIds);

  const claimed = await validateAssignmentsInTx(tx, input, scopeSet);
  const { stockMap, costMap } = await snapshotStockCost(tx, input.branchId, scope.variantIds);
  const { sessionId, code } = await insertSession(tx, input, scope, actor);
  const { assignmentIds, assignmentPins } = await insertAssignments(tx, sessionId, input.assignments);
  const perAssignmentCount = await distributeAndInsertItems(
    tx, input, scope, sessionId, assignmentIds, claimed, stockMap, costMap,
  );

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

/** تحقّق التكليفات: USER يلزمه userId موجود وفعّال وغير مكرّر؛ أصناف التكليف ضمن النطاق وبلا ازدواج.
 *  يُعيد خريطة `variantId → فهرس التكليف` لما ادّعاه كل تكليف صراحةً. */
async function validateAssignmentsInTx(
  tx: Tx,
  input: CreateStocktakeInput,
  scopeSet: Set<number>,
): Promise<Map<number, number>> {
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
  return claimed;
}

/** لقطة الرصيد الدفتري + التكلفة لكل أصناف النطاق (دفعات inArray ≤1000 — لا فصم للجلسة). */
async function snapshotStockCost(
  tx: Tx,
  branchId: number,
  variantIds: number[],
): Promise<{ stockMap: Map<number, number>; costMap: Map<number, string> }> {
  const stockMap = new Map<number, number>();
  const costMap = new Map<number, string>();
  for (const part of chunk(variantIds)) {
    const stockRows = await tx
      .select({ variantId: branchStock.variantId, quantity: branchStock.quantity })
      .from(branchStock)
      .where(and(eq(branchStock.branchId, branchId), inArray(branchStock.variantId, part)));
    for (const r of stockRows) stockMap.set(Number(r.variantId), r.quantity);
    const costRows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, part));
    for (const r of costRows) costMap.set(Number(r.id), String(r.cost ?? "0"));
  }
  return { stockMap, costMap };
}

/** إنشاء صفّ الجلسة (مع الحقول الاختيارية) ورمزها الفريد. */
async function insertSession(
  tx: Tx,
  input: CreateStocktakeInput,
  scope: StkScope,
  actor: StkActor,
): Promise<{ sessionId: number; code: string }> {
  const code = await nextSessionCode(tx);
  const sessionValues: typeof stocktakeSessions.$inferInsert = {
    code,
    name: input.name,
    branchId: input.branchId,
    scopeType: input.scopeType,
    sessionType: input.sessionType ?? "NORMAL",
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
  return { sessionId: extractInsertId(sRes), code };
}

/** التكليفات: PIN فريد داخل الجلسة، يُخزَّن hash فقط ويُعاد النص مرة واحدة. */
async function insertAssignments(
  tx: Tx,
  sessionId: number,
  assignments: CreateStocktakeInput["assignments"],
): Promise<{ assignmentIds: number[]; assignmentPins: (string | undefined)[] }> {
  const usedPins = new Set<string>();
  const assignmentIds: number[] = [];
  const assignmentPins: (string | undefined)[] = [];
  for (const a of assignments) {
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
  return { assignmentIds, assignmentPins };
}

/**
 * توزيع الأصناف: المُدّعى لتكليفه يبقى له؛ وغير المُكلَّف بأي تكليف يُوزَّع كتلاً متتالية
 * متساوية (±1) على كل التكليفات بترتيب variantId تصاعدياً (تكليف واحد ⇒ يستلم الكل =
 * السلوك القديم نفسه). السبب: «الباقي للتكليف الأول» ينهار على جرد شامل حقيقي —
 * الواجهة ترسل ≤1000 معرّف للتكليفات بينما النطاق قد يبلغ آلاف الأصناف فيُغرَق الأول بها كلها.
 * يُدرج صفوف الأصناف على دفعات (≤1000) ويُعيد عدّاد أصناف كل تكليف.
 */
async function distributeAndInsertItems(
  tx: Tx,
  input: CreateStocktakeInput,
  scope: StkScope,
  sessionId: number,
  assignmentIds: number[],
  claimed: Map<number, number>,
  stockMap: Map<number, number>,
  costMap: Map<number, string>,
): Promise<number[]> {
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
  return perAssignmentCount;
}
