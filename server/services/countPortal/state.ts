// حالة بوابة العدّ (جرد أعمى).
// 🔒 يُمنع منعاً باتاً تضمين: expectedQty، الأسعار/التكاليف، كميات أو أسماء عدّات الزملاء.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
import {
  mergePortalState,
  type PortalCatalogItem,
  type PortalCountState,
  type PortalDynamic,
  type PortalState,
  type PortalUnit,
} from "../../../shared/countPortalMerge";
import { requireDb } from "../tx";
import type { PortalIdentity } from "./identity";
import { loadProductIdentificationImages } from "../catalog/productIdentification";

/**
 * مفتاح توقيع وسم النسخة. `JWT_SECRET` في الإنتاج، ومفتاحٌ عشوائيّ لكل عملية عند غيابه
 * (اختبارات/تطوير) — تبدّله عند إعادة التشغيل يكلّف جلبةً كاملةً واحدة لا أكثر، ولا يكسر شيئاً.
 * ⚠️ لا تجعله ثابتاً مكتوباً: الوسم يُصدَّر للعميل، وثباتُه المعلوم يُعيد فتح باب التخمين.
 */
const VERSION_KEY = process.env.JWT_SECRET || randomBytes(32).toString("hex");

/** يوقّع تجميعات البصمة الداخلية فيصير المُعاد وسماً مبهماً غير قابلٍ للعكس. */
function signPortalVersion(raw: string): string {
  return createHmac("sha256", VERSION_KEY)
    .update(raw)
    .digest("base64url")
    .slice(0, 22);
}

/** Keeps the server-only scanner attestation out of the worker-facing payload. */
function publicUnitBreakdown(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    delete parsed.__stocktakeScannerGuard;
    return Object.keys(parsed).length ? JSON.stringify(parsed) : null;
  } catch {
    return raw;
  }
}

// الأنواع ودالّة الدمج مشتركة مع العميل (`shared/countPortalMerge.ts`) كي يستحيل انحرافهما.
export type {
  PortalCatalogItem,
  PortalCountState,
  PortalDynamic,
  PortalItem,
  PortalState,
  PortalUnit,
} from "../../../shared/countPortalMerge";

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
    .innerJoin(
      productVariants,
      eq(stocktakeCounts.variantId, productVariants.id),
    )
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(stocktakeCounts.sessionId, session.id),
        eq(products.isService, false),
      ),
    );

  // الأصناف: تتغيّر بإضافة/حذف، وبتحديث حالة إعادة العدّ (لا يُغيّر المعرّف ولا العدد).
  const [i] = await db
    .select({
      maxId: sql<number>`COALESCE(MAX(${stocktakeItems.id}), 0)`,
      n: sql<number>`COUNT(*)`,
      pendingRecounts: sql<number>`SUM(CASE WHEN ${stocktakeItems.recountStatus} = 'PENDING' THEN 1 ELSE 0 END)`,
      lastRecountAt: sql<number>`COALESCE(MAX(UNIX_TIMESTAMP(${stocktakeItems.recountRequestedAt})), 0)`,
    })
    .from(stocktakeItems)
    .innerJoin(
      productVariants,
      eq(stocktakeItems.variantId, productVariants.id),
    )
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(stocktakeItems.sessionId, session.id),
        eq(products.isService, false),
      ),
    );

  // حالتا الجلسة والتكليف تأتيان من الهوية المُحلَّلة سلفاً في كل نداء ⇒ بلا استعلامٍ إضافي.
  // التكليف داخل البصمة كي لا يتشارك عادّان على جهازٍ واحد وسماً واحداً بعد تبديل الدخول.
  const raw = [
    session.id,
    session.status,
    // أسلوب العدّ من الهوية المُحلَّلة (بلا استعلام) — إدراجه يمنع تجمّد الشاشة لو بُدِّل الأسلوب.
    session.countMethod,
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

  // وسم الكتالوج يُشتقّ من **نفس** تجميعات الأصناف أعلاه (لا استعلامٍ إضافي ولا تجسيد).
  // هذا ما يجعل المسار التزايديّ رخيصاً فعلاً: الراوتر يقارن `cv` قبل أن يبني الكتالوج،
  // فلا يُجسَّد ٣٤١٤ صنفاً ووحداتها وباركوداتها ثمّ تُرمى. الصيغة مطابقة لما يحسبه
  // `getPortalCatalog` حرفياً (session.id + أكبر معرّف صنف + العدد) — أي تغييرٍ في إحداهما
  // يجب أن ينعكس في الأخرى وإلّا لم يتطابق الوسمان أبداً فيُعاد إرسال الكتالوج في كل دورة.
  const cv = catalogVersionOf(
    Number(session.id),
    Number(i?.maxId ?? 0),
    Number(i?.n ?? 0),
  );
  return { v: signPortalVersion(raw), cv };
}

/** صيغة وسم الكتالوج — مصدرٌ واحد يستعمله `getPortalPulse` و`getPortalCatalog` معاً. */
function catalogVersionOf(
  sessionId: number,
  maxItemId: number,
  itemCount: number,
): string {
  return signPortalVersion(`cat:${sessionId}:${maxItemId}:${itemCount}`);
}

/**
 * حالة بوابة العدّ الكاملة (العقد §٥ — `state`) = الكتالوج الساكن ⊕ الحالة المتغيّرة.
 * تبقى بنفس الشكل الخارجيّ بالضبط بعد الفصل، فلا يتغيّر أي مستهلك ولا اختبار.
 * 🔒 يُمنع منعاً باتاً تضمين: expectedQty، الأسعار/التكاليف، كميات أو أسماء عدّات الزملاء.
 */
export async function getPortalState(
  identity: PortalIdentity,
): Promise<PortalState> {
  const [catalog, dyn] = await Promise.all([
    getPortalCatalog(identity),
    getPortalDynamic(identity),
  ]);
  return mergePortalState(catalog.items, dyn);
}

/**
 * الجزء **الساكن**: أصناف الجلسة بأسمائها وSKU ووحدات قياسها وباركوداتها البديلة.
 * ٨٣٪ من حجم الحمولة (٤٢٨ﻙﺐ أسماء + ٣٨٨ﻙﺐ وحدات، مقاسةً على جلسةٍ إنتاجية من ٣٤١٤ صنفاً)
 * ولا يتغيّر خلال العدّ ⇒ يُرسَل مرّةً بوسمه الخاص `cv` ويُخزَّن لدى العميل فلا يتكرّر.
 *
 * ⚠️ `cv` يغطّي **تركيب** الجلسة (إضافة/حذف صنف) لا تحرير الكتالوج نفسه (إعادة تسمية منتج،
 * تبديل باركود) — نادرٌ أثناء الجرد، ويلتقطه التحديث الكامل الدوريّ في `usePulsedCountState`.
 */
export async function getPortalCatalog(
  identity: PortalIdentity,
): Promise<{ cv: string; items: PortalCatalogItem[] }> {
  const db = requireDb();
  const { session } = identity;

  const itemRows = await db
    .select({
      id: stocktakeItems.id,
      variantId: stocktakeItems.variantId,
      productId: products.id,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
    })
    .from(stocktakeItems)
    .innerJoin(
      productVariants,
      eq(stocktakeItems.variantId, productVariants.id),
    )
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(stocktakeItems.sessionId, session.id),
        eq(products.isService, false),
      ),
    )
    .orderBy(asc(stocktakeItems.id));

  const variantIds = itemRows.map((r) => Number(r.variantId));
  const [unitRows, imageUrls] = await Promise.all([
    variantIds.length
      ? db
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
      : Promise.resolve([]),
    loadProductIdentificationImages(
      db,
      itemRows.map((row) => ({
        productId: Number(row.productId),
        variantId: Number(row.variantId),
      })),
      { kind: "stocktake", sessionCode: session.code },
    ),
  ]);
  const activeUnits = unitRows.filter((u) => u.isActive !== false);
  // الباركودات البديلة للوحدات النشطة — العدّاد يمسح أيّ باركود ملصوق (أساسيّاً أو بديلاً).
  const activeUnitIds = activeUnits.map((u) => Number(u.id));
  const aliasRows = activeUnitIds.length
    ? await db
        .select({
          productUnitId: productUnitBarcodes.productUnitId,
          barcode: productUnitBarcodes.barcode,
        })
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
  for (const arr of Array.from(unitsByVariant.values()))
    arr.sort((a, b) => b.factor - a.factor);

  const items: PortalCatalogItem[] = itemRows.map((it) => ({
    variantId: Number(it.variantId),
    productName: it.productName,
    variantName: it.variantName,
    sku: it.sku,
    imageUrl: imageUrls.get(Number(it.variantId)) ?? null,
    units: unitsByVariant.get(Number(it.variantId)) ?? [],
  }));

  // ⚠️ نفس صيغة `getPortalPulse` بالضبط عبر `catalogVersionOf` — لو انحرفتا لما تطابق
  // الوسمان أبداً فأُعيد إرسال الكتالوج في كل دورة وضاع كل التوفير صامتاً. اختبارٌ يحرسها.
  const maxItemId = itemRows.length
    ? Number(itemRows[itemRows.length - 1]!.id)
    : 0;
  return {
    cv: catalogVersionOf(Number(session.id), maxItemId, itemRows.length),
    items,
  };
}

/**
 * الجزء **المتغيّر**: حالتا الجلسة والتكليف، والتقدّم، ومهام إعادة العدّ، وحالات العدّ
 * **للأصناف المعدودة فقط** (غير المذكور = لم يُعدّ) — ١٧٪ من الحمولة وهو وحده ما يتبدّل.
 * 🔒 بلا expectedQty ولا أسعار ولا كميات/أسماء عدّات الزملاء (جرد أعمى).
 */
export async function getPortalDynamic(
  identity: PortalIdentity,
): Promise<PortalDynamic> {
  const db = requireDb();
  const { session, assignment } = identity;
  const myAssignmentId = Number(assignment.id);

  const [branchRows, countRows, itemAgg, recountRows] = await Promise.all([
    db
      .select({ name: branches.name })
      .from(branches)
      .where(eq(branches.id, session.branchId))
      .limit(1),
    db
      .select({
        variantId: stocktakeCounts.variantId,
        assignmentId: stocktakeCounts.assignmentId,
        kind: stocktakeCounts.kind,
        qty: stocktakeCounts.qty,
        unitBreakdown: stocktakeCounts.unitBreakdown,
        countedAt: stocktakeCounts.countedAt,
        reviewApprovedAt: stocktakeItems.reviewApprovedAt,
      })
      .from(stocktakeCounts)
      .innerJoin(
        stocktakeItems,
        and(
          eq(stocktakeItems.sessionId, stocktakeCounts.sessionId),
          eq(stocktakeItems.variantId, stocktakeCounts.variantId),
        ),
      )
      .innerJoin(
        productVariants,
        eq(stocktakeCounts.variantId, productVariants.id),
      )
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(stocktakeCounts.sessionId, session.id),
          eq(products.isService, false),
        ),
      )
      .orderBy(asc(stocktakeCounts.id)),
    db
      .select({ total: sql<number>`COUNT(*)` })
      .from(stocktakeItems)
      .innerJoin(
        productVariants,
        eq(stocktakeItems.variantId, productVariants.id),
      )
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(stocktakeItems.sessionId, session.id),
          eq(products.isService, false),
        ),
      ),
    // مهام إعادة العدّ قليلة ⇒ ضمُّها بأسمائها هنا أرخص من إقحام الأسماء في كل صنف.
    db
      .select({
        variantId: stocktakeItems.variantId,
        productName: products.name,
        variantName: productVariants.variantName,
        recountReason: stocktakeItems.recountReason,
      })
      .from(stocktakeItems)
      .innerJoin(
        productVariants,
        eq(stocktakeItems.variantId, productVariants.id),
      )
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(stocktakeItems.sessionId, session.id),
          eq(stocktakeItems.recountStatus, "PENDING"),
          eq(products.isService, false),
        ),
      )
      .orderBy(asc(stocktakeItems.id)),
  ]);

  const countsByVariant = new Map<number, typeof countRows>();
  for (const c of countRows) {
    const vid = Number(c.variantId);
    const arr = countsByVariant.get(vid);
    if (arr) arr.push(c);
    else countsByVariant.set(vid, [c]);
  }

  let mineCounted = 0;
  let sessionCounted = 0;
  const counts: PortalCountState[] = [];
  for (const [vid, rows] of Array.from(countsByVariant.entries())) {
    // «معدود» = يوجد عدّ فعّال (FIRST/RECOUNT) من أي أحد — VERIFY وحده لا يقع إلا بعد FIRST.
    const counted = rows.some(
      (c) => c.kind === "FIRST" || c.kind === "RECOUNT",
    );
    const myRows = rows.filter(
      (c) => Number(c.assignmentId) === myAssignmentId,
    );
    const myLast = myRows.length ? myRows[myRows.length - 1]! : null;
    const colleagueCounted = rows.some(
      (c) =>
        (c.kind === "FIRST" || c.kind === "RECOUNT") &&
        Number(c.assignmentId) !== myAssignmentId,
    );
    if (counted) sessionCounted++;
    if (myRows.some((c) => c.kind === "FIRST" || c.kind === "RECOUNT"))
      mineCounted++;
    counts.push({
      variantId: vid,
      counted,
      colleagueCounted,
      myCount: myLast
        ? {
            qty: myLast.qty,
            at: myLast.countedAt,
            unitBreakdown: publicUnitBreakdown(myLast.unitBreakdown ?? null),
          }
        : null,
      reviewApproved: rows.some((c) => c.reviewApprovedAt != null),
    });
  }

  const total = Number(itemAgg[0]?.total ?? 0);
  return {
    session: {
      code: session.code,
      name: session.name,
      branchName: branchRows[0]?.name ?? "",
      status: session.status,
      dupPolicy: session.dupPolicy,
      blind: session.blind,
      countMethod: session.countMethod,
    },
    assignment: {
      id: myAssignmentId,
      name: assignment.name,
      zone: assignment.zone,
      status: assignment.status,
    },
    // «لي» و«الجلسة» يتقاسمان نفس المجموع — القائمة مشتركة (سلوكٌ قائم قبل الفصل).
    progress: {
      mine: { counted: mineCounted, total },
      session: { counted: sessionCounted, total },
    },
    recountTasks: recountRows.map((it) => ({
      variantId: Number(it.variantId),
      productName: it.productName,
      variantName: it.variantName,
      reason: it.recountReason ?? "",
    })),
    counts,
  };
}

/* ── نهاية الخدمة ── */
