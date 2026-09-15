// سقوف استرداد مرتجع البيع — **مصدر الحقيقة الوحيد** المشترك بين مسار القراءة
// (`returns.getInvoice` ⇒ ما تعرضه الشاشة) ومسار الكتابة (`returnSaleInTx` ⇒ ما يقبله الخادم).
//
// لماذا وُحِّد (بلاغ المالك ١٧/٨/٢٦): كانت الشاشة تحسب السقوف بنفسها بمنطقٍ مقارِب
// (`Returns.tsx` كان يجمع `paidByMethod` وحده) بينما الخادم يحسبها بمنطقٍ أوسع (حصص العرابين
// + تحصيل المندوب + استبعاد أمانة أجرة التوصيل + طيّ رصيد زين). فكانت الشاشة **تسمح ببناء طلبٍ
// مرفوضٍ حتماً**: يملأ الموظف الكميات والمبلغ ثم يرفضه الخادم برسالة سقفٍ لا يفهمها. المرتجع
// عمليةٌ يوميّةٌ متكرّرة (مزاج الزبائن متقلّب — نصّ المالك)، فوجب أن تكون «غير قابلة للخطأ
// بالبناء»: لا تُعرَض طريقةٌ سيُرفَض بها الاسترداد أصلاً.
//
// ⭐ قرار المالك (١٧/٨/٢٦) — **رافدا القبض كثيرةٌ ورافدا الردّ اثنان: نقدٌ أو بطاقة**:
//   «ممكن العميل دافع بطاقة وممكن نقد وممكن تحويل وممكن رصيد زين، فيتم الردّ إليه نقداً أو
//   عن طريق البطاقة فقط». قبل هذا كان سقف كلّ طريقةٍ محصوراً برافد قبضها ⇒ فاتورةُ بطاقةٍ
//   لزبونٍ عابر **بلا أيّ مسار استرداد بنيوياً** (سقف النقد صفر، وغير النقد يتطلّب عميلاً
//   مسجَّلاً ثمّ سند صرفٍ معلَّقاً باعتماد المالك فيغادر الزبون بلا مال) — علّة
//   INV-1-20260816-00118. مطابقٌ للمبدأ المالي الحاكم: «مالٌ محتجَز يلزمه مسار خروجٍ ممكنٌ دائماً».
//
// 🔒 الثابت المحروس الذي يمنع التسريب: **الوعاء (pool) هو السقف الحاكم لكلا الرافدين**.
//   pool = Σ(المقبوض بكل الطرق) − Σ(المسترَدّ بكل الطرق)، مقصوصاً عند الصفر
//   سقف النقد = سقف البطاقة = pool
//   ⇒ Σ(المسترَدّ) ≤ Σ(المقبوض) حتماً مهما تعدّدت المرتجعات الجزئية: كلّ استردادٍ يُنقص
//   الوعاء نفسه، فلا يمكن استرداد ١٠٠ نقداً ثمّ ١٠٠ بطاقةً على فاتورةٍ قبضت ١٠٠.
//   (الطرق الأخرى — تحويل/صك/محفظة — تبقى **رافدَ قبضٍ لا رافدَ ردّ**: سقفها محصورٌ برافدها
//    وبالوعاء معاً، ولا تُعرَض في الشاشة أصلاً. إبقاؤها محسوبةً يحفظ توافق المسارات القديمة.)
//
// السقف النهائي لكل طريقة يُقصّ إضافةً بقيمة المرتجع الجاري (`returnedTotal`) في نقطة الاستدعاء.
import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import { receipts } from "../../../drizzle/schema";
import { money } from "../money";

/** طرق الاسترداد التي يقبلها عقد الخادم (TELECOM ليست طريقة **ردٍّ** — تُطوى في النقد). */
export const REFUND_METHODS = ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/**
 * رافدا الردّ **المعروضان** (قرار المالك ١٧/٨/٢٦): نقدٌ أو بطاقة لا غير.
 * الباقي يبقى مقبولاً في العقد للمسارات القديمة/الآلية لكنّه لا يُعرَض للموظف — «لا تُفتَح
 * طريقةٌ في شاشة قبل التحقّق أنّ عقد الخادم يقبل حمولتها»، وهنا العكس: لا تُعرَض طريقةٌ
 * لا يريدها العمل ولو قبِلها العقد. راجع ذاكرة [[inbound-payment-policy-2026-08-16]].
 */
export const SURFACED_REFUND_METHODS = ["CASH", "CARD"] as const satisfies readonly RefundMethod[];

/** هل يستوعب هذا الرافد الوعاء كلّه (رافد ردٍّ) أم يقتصر على ما قُبض به (رافد قبضٍ فقط)؟ */
export function isSurfacedRefundMethod(m: RefundMethod): boolean {
  return (SURFACED_REFUND_METHODS as readonly string[]).includes(m);
}

/** رافد القبض كما يُخزَّن — TELECOM (رصيد زين) رافدُ قبضٍ لا رافدَ ردّ. */
type InboundRail = RefundMethod | "TELECOM";

/** أصغر واجهة تنفيذٍ نحتاجها: تعمل على `Tx` (كتابة، مع أقفال) و`DB` (قراءة) سواءً. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/** يطوي رافد القبض على طريقة الردّ المقابلة: رصيد زين يُستردّ **نقداً** (لا سكّة ردٍّ لرصيدٍ شُحن). */
function railToRefundMethod(rail: string): RefundMethod | null {
  if (rail === "TELECOM") return "CASH";
  return (REFUND_METHODS as readonly string[]).includes(rail) ? (rail as RefundMethod) : null;
}

type RefundInputRow = {
  rail?: unknown;
  direction?: unknown;
  amount?: unknown;
};

function refundCapSnapshot(
  receiptRows: RefundInputRow[],
  applicationRows: RefundInputRow[],
  collectedAmount: unknown,
): RefundCapSnapshot {
  const inByMethod = new Map<RefundMethod, Decimal>();
  const outByMethod = new Map<RefundMethod, Decimal>();
  const add = (target: Map<RefundMethod, Decimal>, m: RefundMethod, v: Decimal) =>
    target.set(m, (target.get(m) ?? money(0)).plus(v));

  for (const r of receiptRows) {
    const m = railToRefundMethod(String(r.rail ?? "") as InboundRail);
    if (!m) continue;
    add(r.direction === "IN" ? inByMethod : outByMethod, m, money(String(r.amount ?? "0")));
  }
  for (const r of applicationRows) {
    const m = railToRefundMethod(String(r.rail ?? "") as InboundRail);
    if (!m) continue;
    add(inByMethod, m, money(String(r.amount ?? "0")));
  }
  add(inByMethod, "CASH", money(String(collectedAmount ?? "0")));

  let totalIn = money(0);
  let totalOut = money(0);
  inByMethod.forEach((v) => { totalIn = totalIn.plus(v); });
  outByMethod.forEach((v) => { totalOut = totalOut.plus(v); });
  const pool = Decimal.max(money(0), totalIn.minus(totalOut));

  const netByMethod = new Map<RefundMethod, Decimal>();
  const capByMethod = new Map<RefundMethod, Decimal>();
  for (const m of REFUND_METHODS) {
    const net = Decimal.max(money(0), (inByMethod.get(m) ?? money(0)).minus(outByMethod.get(m) ?? money(0)));
    netByMethod.set(m, net);
    capByMethod.set(m, isSurfacedRefundMethod(m) ? pool : Decimal.min(pool, net));
  }

  return { pool, grossIn: totalIn, grossOut: totalOut, netByMethod, capByMethod };
}

export interface RefundCapSnapshot {
  /** الوعاء الحاكم: Σ(المقبوض بكل الطرق) − Σ(المسترَدّ بكل الطرق)، مقصوصاً عند الصفر. */
  pool: Decimal;
  /**
   * Σ(المقبوض بكل الطرق) **قبل** طرح المستردّ — أساسُ أثر `PAID_AMOUNT` (APPLY) في محرّك العكس.
   * ⭐ مُجسِّدُ الفاتورة (`reversal/materialize/invoice.ts`) يقرأ الوعاء من هنا **لا من استعلامٍ
   * موازٍ**: كان له استعلامُه الخاصّ الذي يغفل حصصَ العربون المطبَّقة على **أمر الشغل** وتحصيلَ
   * المندوب المورَّد، فيُجسِّد مقبوضَ فاتورة التسليم صفراً ولا يخرج ردٌّ من الدرج بينما هذا
   * الملفّ يُجيز ٱسترداده (أمسكه `receptionDeposits.test.ts` R1: عجزٌ −15,000 في الدرج).
   */
  grossIn: Decimal;
  /** Σ(المستردّ بكل الطرق) سلفاً — إيصالاتُ OUT المتجسِّدة على الفاتورة. */
  grossOut: Decimal;
  /** صافي المقبوض لكل طريقة ردّ (زين مطويٌّ في النقد) — إفصاحٌ للموظف وسقفٌ لغير النقد. */
  netByMethod: Map<RefundMethod, Decimal>;
  /** السقف الأقصى لكل طريقة **قبل** قصّه بقيمة المرتجع الجاري. */
  capByMethod: Map<RefundMethod, Decimal>;
}

/**
 * يحسب لقطة سقوف الاسترداد لفاتورةٍ واحدة.
 *
 * @param exec  `tx` داخل المعاملة (مع `lock`) أو `db` للقراءة.
 * @param lock  يضيف `FOR UPDATE` على إيصالات الفاتورة — إلزاميّ في مسار الكتابة كي لا يُبنى
 *              السقف على لقطةٍ قديمة بينما استردادٌ متزامنٌ يستهلك الوعاء نفسه.
 */
export async function loadRefundCaps(
  exec: SqlExecutor,
  invoiceId: number,
  opts: { lock?: boolean } = {},
): Promise<RefundCapSnapshot> {
  const lockClause = opts.lock ? sql` FOR UPDATE` : sql``;

  // ① إيصالات الفاتورة المختومة بها — مادّية ومعتمَدة فقط.
  //    استبعاد **أمانة أجرة التوصيل**: مالُ طرفٍ ثالث مختومٌ بالفاتورة تشغيلياً ولم يمسّ
  //    `paidAmount`؛ احتسابه «مقبوضاً» كان يفتح رداً من أمانة المندوب (تدقيق ٦/٨: ث٣/ث٥/ث١٢).
  //    بصمته البنيوية: قيد `DELIVERY_FEE_HELD` مربوطٌ بالإيصال.
  // ⚠️ أسماء الأعمدة الخام ≠ أسماء خصائص drizzle (`status` ⇒ `receiptStatus`،
  //    `approvalStatus` ⇒ `receiptApprovalStatus`). لذلك نُدرج مراجع الأعمدة من المخطّط
  //    (بلا alias للجدول) بدل كتابتها نصّاً — فلا تنكسر الاستعلامات عند إعادة التسمية.
  const receiptRows = rowsOf(
    await exec.execute(sql`
      SELECT ${receipts.paymentMethod} AS rail,
             ${receipts.direction} AS direction,
             CAST(${receipts.amount} AS CHAR) AS amount
      FROM ${receipts}
      WHERE ${receipts.invoiceId} = ${invoiceId}
        AND ${receipts.status} IN ('COMPLETED','REVERSED')
        AND ${receipts.approvalStatus} = 'APPROVED'
        AND NOT EXISTS (
          SELECT 1 FROM accountingEntries ae
          WHERE ae.receiptId = ${receipts.id} AND ae.entryType = 'DELIVERY_FEE_HELD'
        )${lockClause}
    `),
  );

  // ② حصص العرابين المُطبَّقة على هذه الفاتورة (أو على أمر شغلها) التي **إيصال أمّها غير مختوم**
  //    بها — تدخل `paidAmount` ولا يراها ① ⇒ فاتورةٌ PAID كان مرتجعُها بلا مسار استرداد.
  //    نستبعد ما إيصال أمّه مختومٌ بهذه الفاتورة (محسوبٌ في ① سلفاً — لا ازدواج).
  const applicationRows = rowsOf(
    await exec.execute(sql`
      SELECT coll.orderPayMethod AS rail, CAST(COALESCE(SUM(app.amount), 0) AS CHAR) AS amount
      FROM orderPayments app
      JOIN orderPayments coll ON coll.id = app.parentPaymentId
      LEFT JOIN receipts pr ON pr.id = coll.receiptId
      WHERE app.orderPayKind = 'APPLICATION'
        AND (
          (app.orderPayAppliedKind = 'INVOICE' AND app.appliedId = ${invoiceId})
          OR (app.orderPayAppliedKind = 'WORKORDER' AND app.appliedId IN (
            SELECT wo.id FROM workOrders wo WHERE wo.invoiceId = ${invoiceId}
          ))
        )
        AND (pr.id IS NULL OR pr.invoiceId IS NULL OR pr.invoiceId <> ${invoiceId})
      GROUP BY coll.orderPayMethod
    `),
  );

  // ③ ما حصّله المندوب وورّده: إيصال التوريد مجمَّعٌ لعدّة فواتير بلا `invoiceId` فلا يراه ①.
  //    قرار المالك (٦/٨): مالٌ نقديّ وصلنا فعلاً ⇒ يدخل الوعاء برافدٍ نقديّ.
  const collectedRows = rowsOf(
    await exec.execute(sql`
      SELECT CAST(COALESCE(SUM(cn.collectedAmount), 0) AS CHAR) AS amount
      FROM deliveryConsignments cn
      WHERE cn.invoiceId = ${invoiceId}
        AND cn.consignmentStatus IN ('DELIVERED','PARTIAL')
    `),
  );

  return refundCapSnapshot(receiptRows, applicationRows, collectedRows[0]?.amount);
}

/**
 * نسخة القراءة المجمّعة لصناديق القرارات والتقارير. تنفّذ ثلاث قراءات ثابتة مهما بلغ عدد
 * الفواتير، ثم تبني لكل فاتورة اللقطة نفسها التي تبنيها `loadRefundCaps`. لا تُستعمل في
 * التنفيذ المالي؛ مسار الكتابة يحتاج قفل `FOR UPDATE` الخاص بالدالة المفردة أعلاه.
 */
export async function loadRefundCapsByInvoiceIds(
  exec: SqlExecutor,
  requestedInvoiceIds: number[],
): Promise<Map<number, RefundCapSnapshot>> {
  const invoiceIds = Array.from(new Set(requestedInvoiceIds.filter(Number.isSafeInteger)));
  if (!invoiceIds.length) return new Map();
  const idList = sql.join(invoiceIds.map((id) => sql`${id}`), sql`, `);

  const rawRows = await Promise.all([
    exec.execute(sql`
      SELECT ${receipts.invoiceId} AS invoiceId,
             ${receipts.paymentMethod} AS rail,
             ${receipts.direction} AS direction,
             CAST(COALESCE(SUM(${receipts.amount}), 0) AS CHAR) AS amount
      FROM ${receipts}
      WHERE ${receipts.invoiceId} IN (${idList})
        AND ${receipts.status} IN ('COMPLETED','REVERSED')
        AND ${receipts.approvalStatus} = 'APPROVED'
        AND NOT EXISTS (
          SELECT 1 FROM accountingEntries ae
          WHERE ae.receiptId = ${receipts.id} AND ae.entryType = 'DELIVERY_FEE_HELD'
        )
      GROUP BY ${receipts.invoiceId}, ${receipts.paymentMethod}, ${receipts.direction}
    `),
    exec.execute(sql`
      SELECT CASE
               WHEN app.orderPayAppliedKind = 'INVOICE' THEN app.appliedId
               ELSE wo.invoiceId
             END AS invoiceId,
             coll.orderPayMethod AS rail,
             CAST(COALESCE(SUM(app.amount), 0) AS CHAR) AS amount
      FROM orderPayments app
      JOIN orderPayments coll ON coll.id = app.parentPaymentId
      LEFT JOIN receipts pr ON pr.id = coll.receiptId
      LEFT JOIN workOrders wo
        ON app.orderPayAppliedKind = 'WORKORDER' AND wo.id = app.appliedId
      WHERE app.orderPayKind = 'APPLICATION'
        AND (
          (app.orderPayAppliedKind = 'INVOICE' AND app.appliedId IN (${idList}))
          OR (app.orderPayAppliedKind = 'WORKORDER' AND wo.invoiceId IN (${idList}))
        )
        AND (
          pr.id IS NULL OR pr.invoiceId IS NULL OR pr.invoiceId <>
            CASE WHEN app.orderPayAppliedKind = 'INVOICE' THEN app.appliedId ELSE wo.invoiceId END
        )
      GROUP BY invoiceId, coll.orderPayMethod
    `),
    exec.execute(sql`
      SELECT cn.invoiceId AS invoiceId,
             CAST(COALESCE(SUM(cn.collectedAmount), 0) AS CHAR) AS amount
      FROM deliveryConsignments cn
      WHERE cn.invoiceId IN (${idList})
        AND cn.consignmentStatus IN ('DELIVERED','PARTIAL')
      GROUP BY cn.invoiceId
    `),
  ]);
  const receiptRows = rowsOf(rawRows[0]);
  const applicationRows = rowsOf(rawRows[1]);
  const collectedRows = rowsOf(rawRows[2]);

  const groupedReceipts = new Map<number, RefundInputRow[]>();
  const groupedApplications = new Map<number, RefundInputRow[]>();
  const collectedByInvoice = new Map<number, unknown>();
  const append = (target: Map<number, RefundInputRow[]>, row: any) => {
    const invoiceId = Number(row.invoiceId);
    if (!Number.isSafeInteger(invoiceId)) return;
    const current = target.get(invoiceId) ?? [];
    current.push(row);
    target.set(invoiceId, current);
  };
  receiptRows.forEach((row) => append(groupedReceipts, row));
  applicationRows.forEach((row) => append(groupedApplications, row));
  for (const row of collectedRows) {
    const invoiceId = Number(row.invoiceId);
    if (Number.isSafeInteger(invoiceId)) collectedByInvoice.set(invoiceId, row.amount);
  }

  return new Map(invoiceIds.map((invoiceId) => [
    invoiceId,
    refundCapSnapshot(
      groupedReceipts.get(invoiceId) ?? [],
      groupedApplications.get(invoiceId) ?? [],
      collectedByInvoice.get(invoiceId) ?? "0",
    ),
  ]));
}

/** السقف الفعليّ لطريقةٍ بعد قصّه بقيمة المرتجع الجاري — نفس المعادلة في القراءة والكتابة. */
export function effectiveRefundCap(
  snapshot: RefundCapSnapshot,
  method: RefundMethod,
  returnedTotal: Decimal,
): Decimal {
  return Decimal.min(returnedTotal, snapshot.capByMethod.get(method) ?? money(0));
}
