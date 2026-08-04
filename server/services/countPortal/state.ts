// حالة بوابة العدّ (جرد أعمى).
// 🔒 يُمنع منعاً باتاً تضمين: expectedQty، الأسعار/التكاليف، كميات أو أسماء عدّات الزملاء.
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  branches,
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
  stocktakeCounts,
  stocktakeItems,
} from "../../../drizzle/schema";
import { createHmac, randomBytes } from "node:crypto";
import { requireDb } from "../tx";
import type { PortalIdentity } from "./identity";

/**
 * مفتاح توقيع وسم النسخة. `JWT_SECRET` في الإنتاج، ومفتاحٌ عشوائيّ لكل عملية عند غيابه
 * (اختبارات/تطوير) — تبدّله عند إعادة التشغيل يكلّف جلبةً كاملةً واحدة لا أكثر، ولا يكسر شيئاً.
 * ⚠️ لا تجعله ثابتاً مكتوباً: الوسم يُصدَّر للعميل، وثباتُه المعلوم يُعيد فتح باب التخمين.
 */
const VERSION_KEY = process.env.JWT_SECRET || randomBytes(32).toString("hex");

/** يوقّع تجميعات البصمة الداخلية فيصير المُعاد وسماً مبهماً غير قابلٍ للعكس. */
function signPortalVersion(raw: string): string {
  return createHmac("sha256", VERSION_KEY).update(raw).digest("base64url").slice(0, 22);
}

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
 * بصمة نسخةٍ رخيصة لحالة البوابة — بديل الاستقصاء الثقيل.
 *
 * **لماذا:** `getPortalState` يُجسّد كل أصناف الجلسة + كل عدّاتها + وحدات القياس وباركوداتها
 * البديلة في **كل** نداء. على جلسة إنتاجية واقعية (٣٣٨٣ صنفاً/١١٩٢ عدّة) ذلك ≈ ٨–١٥ ألف صفّ
 * و~١٠٣ﻙﺐ لكل ردّ؛ وباستقصاء كل ٥ ثوانٍ × عشرات العادّين صار يمثّل **٩٤٪ من حركة الخادم**
 * (١٤١ﻣﺐ/٦٨د مقاسة على nginx) ويدفع الذاكرة من ٣٠٠م إلى ٦٠٠م خلال دقيقة فيضرب سقف PM2.
 * تتفاقم مع الوقت لأنّ عدد العدّات ينمو خلال الجرد.
 *
 * **العقد:** تعيد وسماً يتغيّر **كلّما تغيّر شيءٌ يظهر في `state`**؛ يُمرّره العميل في
 * `knownVersion` فيردّ الخادم «بلا تغيير» رخيصاً بدل الحمولة الكاملة (نمط ETag بجولةٍ واحدة).
 *
 * 🔒 **الوسم مُفتَّح (HMAC) عمداً — لا تُعِده قيمةً خاماً.** الصيغة الأولى كانت تُعيد
 * `BIT_XOR(CRC32(...))` خاماً، وهي **قابلة للعكس**: بين نبضتين تفصلهما عدّةٌ واحدة يعطي
 * `XOR` للوسمين قيمةَ CRC32 لذلك الصفّ وحده، ومعرّفُه معلومٌ من فرق `maxId`، والنوع وصيغة
 * التفصيل ونافذة الوقت محصورة ⇒ يُخمَّن مقدار الكمية بالقوة الغاشمة حتى يطابق CRC32، فينكشف
 * عدّ الزميل ويسقط **الجرد الأعمى** (أمسكته مراجعة Codex). المعالجة: التجميعات تبقى داخلية،
 * والمُعاد هو `HMAC-SHA256` عليها بمفتاح خادميّ ⇒ لا بنية جبرية تُستغلّ ولا تخمين بلا المفتاح.
 *
 * ⚠️ **حدود البصمة (مقصودة وموثَّقة):** تغطّي العدّات وأصناف الجلسة وطلبات إعادة العدّ وحالتَي
 * الجلسة والتكليف. لا تغطّي تعديلات **الكتالوج** (اسم منتج/باركود/وحدة تُحرَّر أثناء الجرد) —
 * وهي نادرة. لذلك تُبقي الواجهة تحديثاً دورياً إجبارياً كشبكة أمان بتقادمٍ محدود، بدل أن
 * تعتمد على البصمة وحدها. أيّ حقلٍ جديد يُضاف إلى `state` من مصدرٍ غير مُغطّى هنا **يجب** أن
 * يُضاف إلى البصمة وإلّا تجمّدت شاشة العادّ صامتةً — وهو عطلٌ أسوأ من البطء الذي نعالجه.
 */
export async function getPortalPulse(identity: PortalIdentity) {
  const db = requireDb();
  const { session, assignment } = identity;

  // العدّات: **ليست append-only**. تحديث العادّ لعدّته على نفس الصنف يُحدِّث الصفّ نفسه ولا
  // يُنشئ صفّاً جديداً (يُثبته اختبار «تحديث FIRST الذاتي: لا يكرّر صفاً»). لذلك (أكبر معرّف +
  // العدد) وحدهما **لا يكفيان** — كانا يُبقيان الوسم ثابتاً بعد تعديل كميةٍ فتتجمّد شاشة
  // العادّ على كميةٍ قديمة (أمسكه اختبار النبضة قبل الدمج). نضيف مجموع الكميات وأحدث وقت عدّ
  // وعدد العدّات الفعّالة كي يلتقط الوسم تعديل القيمة وتبدّل النوع، لا الإضافة وحدها.
  const [c] = await db
    .select({
      maxId: sql<number>`COALESCE(MAX(${stocktakeCounts.id}), 0)`,
      n: sql<number>`COUNT(*)`,
      // بصمة محتوى **غير قابلة للعكس**: XOR لـCRC32 لكل صفّ (المعرّف+الكمية+النوع+التفصيل+الوقت).
      // ⛔ لا تستعمل SUM(qty) هنا: مجموع الكميات يشمل عدّات الزملاء، فيستنتج العادّ كمية زميله
      // من فرق المجموع قبل/بعد ⇒ خرقٌ مباشر للجرد الأعمى (الحظر في رأس هذا الملف). الـXOR
      // يتبدّل عند أي تغيّر لكنه لا يكشف قيمةً بعينها.
      crc: sql<number>`COALESCE(BIT_XOR(CRC32(CONCAT_WS(':', ${stocktakeCounts.id}, ${stocktakeCounts.qty}, ${stocktakeCounts.kind}, COALESCE(${stocktakeCounts.unitBreakdown}, ''), COALESCE(UNIX_TIMESTAMP(${stocktakeCounts.countedAt}), 0)))), 0)`,
    })
    .from(stocktakeCounts)
    .where(eq(stocktakeCounts.sessionId, session.id));

  // الأصناف: تتغيّر بإضافة/حذف، وبتحديث حالة إعادة العدّ (لا يُغيّر المعرّف ولا العدد).
  const [i] = await db
    .select({
      maxId: sql<number>`COALESCE(MAX(${stocktakeItems.id}), 0)`,
      n: sql<number>`COUNT(*)`,
      pendingRecounts: sql<number>`SUM(CASE WHEN ${stocktakeItems.recountStatus} = 'PENDING' THEN 1 ELSE 0 END)`,
      lastRecountAt: sql<number>`COALESCE(MAX(UNIX_TIMESTAMP(${stocktakeItems.recountRequestedAt})), 0)`,
    })
    .from(stocktakeItems)
    .where(eq(stocktakeItems.sessionId, session.id));

  // حالتا الجلسة والتكليف تأتيان من الهوية المُحلَّلة سلفاً في كل نداء ⇒ بلا استعلامٍ إضافي.
  // التكليف داخل البصمة كي لا يتشارك عادّان على جهازٍ واحد وسماً واحداً بعد تبديل الدخول.
  const raw = [
    session.id,
    session.status,
    assignment.id,
    assignment.status,
    Number(c?.maxId ?? 0),
    Number(c?.n ?? 0),
    Number(c?.crc ?? 0),
    Number(i?.maxId ?? 0),
    Number(i?.n ?? 0),
    Number(i?.pendingRecounts ?? 0),
    Number(i?.lastRecountAt ?? 0),
  ].join(":");

  return { v: signPortalVersion(raw) };
}

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
    // The count list is deliberately shared. Field assignmentId is retained in
    // storage for legacy rows, but no longer represents ownership of a product.
    const isMine = true;
    const myCounts = counts.filter((c) => Number(c.assignmentId) === myAssignmentId);
    const myLast = myCounts.length ? myCounts[myCounts.length - 1] : null;
    const colleagueCounted = counts.some(
      (c) => (c.kind === "FIRST" || c.kind === "RECOUNT") && Number(c.assignmentId) !== myAssignmentId
    );
    if (counted) sessionCounted++;
    mineTotal++;
    if (myCounts.some((c) => c.kind === "FIRST" || c.kind === "RECOUNT")) mineCounted++;
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
  // إعادة العدّ متاحة لأي عامل متصل؛ يوجّهه المشرف ميدانياً إلى الصنف المطلوب.
  const recountTasks = itemRows
    .filter((it) => it.recountStatus === "PENDING")
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
