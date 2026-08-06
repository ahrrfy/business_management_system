import { TRPCError } from "@trpc/server";
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { z } from "zod";
import { accountingEntries, customers, invoiceItems, invoices, productUnits, productVariants, products, receipts, users } from "../../drizzle/schema";
import { money } from "../services/money";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { returnSale } from "../services/returnService";
import { router, salesManagerProcedure } from "../trpc";
import { nonNegMoneyString } from "../lib/schemas";
import { escLike } from "../lib/sqlLike";
import { isDupEntry } from "@shared/errorMap.ar";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على entryDate).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

// المرتجعات تعكس مخزوناً ونقداً ⇒ مدير فأعلى.
export const returnRouter = router({
  create: salesManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        lines: z.array(z.object({ invoiceItemId: z.number().int().positive(), baseQuantity: z.number().int().positive() })).min(1),
        // shiftId اختياري: يُلزَم فقط حين يتعدّد الدرج المفتوح بالفرع (resolveBranchCashShiftTx
        // يرمي طالباً التحديد حينها) — يختار المستخدم أيّ درجٍ خرج منه النقد فعلياً.
        refund: z.object({ amount: nonNegMoneyString, method, shiftId: z.number().int().positive().optional() }).optional(),
        restock: z.boolean().optional(),
        // idempotency: نفس المفتاح ⇒ مرتجع واحد (لا استرداد/إرجاع/خصم AR مزدوج عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // G3 (١٩/٦/٢٦): استبدال fallback `?? 1` — مرتجع يؤثّر على ذمم وصندوق فرع محدّد، لا فرع افتراضي.
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إنشاء مرتجع" });
      }
      const actorBranchId = Number(ctx.user.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // G8: تمرير role لتمكين فحص ملكية الفرع داخل returnSale (admin يتجاوز).
          const res = await returnSale(input, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role });
          await logAudit(ctx, { action: "return.create", entityType: "invoice", entityId: input.invoiceId, newValue: { lines: input.lines.length, refund: input.refund?.amount } });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue; // سباق نفس المفتاح ⇒ أعد المحاولة فيُرى المرتجع الأول replay
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام المرتجع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام المرتجع (تكرار)" });
    }),

  /** سجلّ مرتجعات البيع (قيود RETURN ذات فاتورة بلا مورد) — فلاتر عميل/فرع/فترة/رقم فاتورة/منفّذ
   *  + ترقيم خادمي. الاستعلام مباشر هنا (لا listSalesReturns من الخدمة، القاصرة عن q/createdBy —
   *  تبقى بلا مسّ — نمط reservations.list/quotations.list) بنفس شروط الخدمة حرفياً + الفلترين الجديدين. */
  list: salesManagerProcedure
    .input(
      z
        .object({
          customerId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().nonnegative().optional(),
          // بحث خادمي برقم الفاتورة (كل صفوف هذا السجلّ مرتبطة بفاتورة أصلاً — invoiceId NOT NULL).
          q: z.string().trim().min(1).max(100).optional(),
          // فلتر منفّذ المرتجع (accountingEntries.createdBy) — لا مالك الفاتورة/العميل.
          createdBy: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع: admin يختار الفرع بحرّية؛ غير-admin مُقيَّد بفرعه. مدير بلا فرع مُسنَد ⇒
      // FORBIDDEN لا فلتر مفتوح (وإلّا تسرّبت مرتجعات كل الفروع) — مرآةٌ لفحص create/getInvoice.
      let branchId: number | undefined;
      if (ctx.user.role === "admin") {
        branchId = input?.branchId;
      } else if (ctx.user.branchId != null) {
        branchId = Number(ctx.user.branchId);
      } else {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }

      const db = getDb();
      if (!db) return { rows: [], total: 0 };
      const limit = Math.min(Math.max(input?.limit ?? 50, 1), 200);
      const offset = input?.offset ?? 0;
      const where = [
        eq(accountingEntries.entryType, "RETURN"),
        // مرتجع البيع: مرتبط بفاتورة ولا مورد له — عكس مرتجع الشراء (supplierId NOT NULL).
        isNull(accountingEntries.supplierId),
        isNotNull(accountingEntries.invoiceId),
      ];
      if (input?.customerId) where.push(eq(accountingEntries.customerId, input.customerId));
      if (branchId) where.push(eq(accountingEntries.branchId, branchId));
      // entryDate عمود DATE ⇒ نقارن بمنتصف ليل UTC (timezone:"Z") ليطابق ما يُخزَّن فعلياً.
      if (input?.from) where.push(gte(accountingEntries.entryDate, new Date(input.from + "T00:00:00.000Z")));
      if (input?.to) where.push(lte(accountingEntries.entryDate, new Date(input.to + "T00:00:00.000Z")));
      if (input?.createdBy) where.push(eq(accountingEntries.createdBy, input.createdBy));
      // بحث آمن (escLike + ESCAPE '!') على رقم الفاتورة — يستلزم الانضمام لـinvoices في العدّ أيضاً.
      if (input?.q) {
        const pat = `%${escLike(input.q)}%`;
        where.push(sql`${invoices.invoiceNumber} LIKE ${pat} ESCAPE '!'`);
      }

      const rows = await db
        .select({
          id: accountingEntries.id,
          entryDate: accountingEntries.entryDate,
          branchId: accountingEntries.branchId,
          invoiceId: accountingEntries.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          customerId: accountingEntries.customerId,
          customerName: customers.name,
          amount: accountingEntries.amount,
          notes: accountingEntries.notes,
          createdAt: accountingEntries.createdAt,
          performedBy: accountingEntries.createdBy,
          performedByName: accountingEntries.createdByNameSnapshot,
        })
        .from(accountingEntries)
        .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
        .leftJoin(customers, eq(accountingEntries.customerId, customers.id))
        .where(and(...where))
        .orderBy(sql`${accountingEntries.id} DESC`)
        .limit(limit)
        .offset(offset);

      const totalRow = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(accountingEntries)
        .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
        .where(and(...where));

      return { rows, total: Number(totalRow[0]?.c ?? 0) };
    }),

  /** منفّذو المرتجعات (createdBy مميّز على قيود RETURN المطابقة لنطاق الفرع) — يغذّي فلتر
   *  «منفّذ المرتجع» بلا كشف دليل المستخدمين الكامل (users.list حصريّ لـadminProcedure، والمدير
   *  غير-admin لا يصله — نمط sales.salespeople حرفياً). */
  performers: salesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [] as { id: number; name: string }[];
      let branchId: number | undefined;
      if (ctx.user.role === "admin") {
        branchId = input?.branchId;
      } else if (ctx.user.branchId != null) {
        branchId = Number(ctx.user.branchId);
      } else {
        return [];
      }
      const where = [
        eq(accountingEntries.entryType, "RETURN"),
        isNull(accountingEntries.supplierId),
        isNotNull(accountingEntries.invoiceId),
        isNotNull(accountingEntries.createdBy),
      ];
      if (branchId != null) where.push(eq(accountingEntries.branchId, branchId));
      const rows = await db
        .select({
          id: accountingEntries.createdBy,
          // لقطة الاسم وقت المرتجع أولى (يبقى صحيحاً حتى لو تغيّر اسم المستخدم لاحقاً)، والاسم
          // الحيّ احتياطي لصفوف قديمة سابقة على إضافة اللقطة.
          name: sql<string>`COALESCE(MAX(${accountingEntries.createdByNameSnapshot}), MAX(${users.name}), '—')`,
        })
        .from(accountingEntries)
        .leftJoin(users, eq(accountingEntries.createdBy, users.id))
        .where(and(...where))
        .groupBy(accountingEntries.createdBy)
        .orderBy(sql`name ASC`);
      return rows.map((r) => ({ id: Number(r.id), name: r.name }));
    }),

  getInvoice: salesManagerProcedure.input(z.object({ invoiceId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return null;
    const inv = (
      await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          branchId: invoices.branchId,
          customerId: invoices.customerId,
          customerName: customers.name,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          paymentMethod: invoices.paymentMethod,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
    )[0];
    if (!inv) return null;
    // عزل الفرع (IDOR قراءة): مدير فرعٍ لا يقرأ تفاصيل فاتورة فرعٍ آخر (بنود/عميل/مبالغ).
    // مرآةٌ لفحص ملكية الفرع في returnSale.create؛ admin يتجاوز، وغياب الفرع للمدير ⇒ منع.
    if (ctx.user.role !== "admin" && Number(inv.branchId) !== Number(ctx.user.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة لا تخصّ فرعك" });
    }

    const rows = await db
      .select({
        invoiceItemId: invoiceItems.id,
        productName: products.name,
        variantName: productVariants.variantName,
        color: productVariants.color,
        size: productVariants.size,
        sku: productVariants.sku,
        unitName: productUnits.unitName,
        conversionFactor: productUnits.conversionFactor,
        baseQuantity: invoiceItems.baseQuantity,
        returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
        unitPrice: invoiceItems.unitPrice,
        total: invoiceItems.total,
      })
      .from(invoiceItems)
      .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
      .where(eq(invoiceItems.invoiceId, input.invoiceId));

    const items = rows.map((r) => {
      const variantLabel =
        r.variantName ?? ([r.color, r.size].filter((v): v is string => !!v).join(" / ") || r.sku);
      const remaining = r.baseQuantity - r.returnedBaseQuantity;
      return {
        invoiceItemId: Number(r.invoiceItemId),
        productName: r.productName,
        variantLabel,
        unitName: r.unitName ?? "",
        // معامل تحويل وحدة البيع (درزن=12…) — الشاشة تعرض «١ درزن = ١٢ قطعة» وتَخطو به،
        // فلا يحسب الموظف الوحدة الأساس ذهنياً (كان أكبر مصدر خطأ كميات المرتجع).
        conversionFactor: Number(r.conversionFactor ?? 1) || 1,
        baseQuantity: r.baseQuantity,
        returnedBaseQuantity: r.returnedBaseQuantity,
        remaining,
        unitPrice: r.unitPrice,
        total: r.total,
      };
    });

    // تبسيط المرتجعات (طلب مالك ٦/٨): «بمَ دُفعت هذه الفاتورة فعلاً؟» — الشاشة كانت عمياء
    // فيختار الموظف «نقدي» لفاتورة بطاقةٍ ويُرفض بعد ملء كل شيء. الصافي لكل طريقة =
    // Σ(IN) − Σ(OUT) للإيصالات المختومة + حصص العرابين المطبَّقة غير المختومة (نفس منطق
    // سقف returnService حرفياً، مجموعاً بالطريقة). رصيد زين يُطوى في سقف النقد (قرار ٦/٨).
    const pmRows = await db
      .select({
        method: receipts.paymentMethod,
        net: sql<string>`CAST(COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0) AS CHAR)`,
      })
      .from(receipts)
      .where(and(eq(receipts.invoiceId, input.invoiceId), eq(receipts.status, "COMPLETED")))
      .groupBy(receipts.paymentMethod);
    const appRes = await db.execute(sql`
      SELECT coll.orderPayMethod AS method, CAST(COALESCE(SUM(app.amount), 0) AS CHAR) AS net
      FROM orderPayments app
      JOIN orderPayments coll ON coll.id = app.parentPaymentId
      LEFT JOIN receipts pr ON pr.id = coll.receiptId
      WHERE app.orderPayKind = 'APPLICATION'
        AND (
          (app.orderPayAppliedKind = 'INVOICE' AND app.appliedId = ${input.invoiceId})
          OR (app.orderPayAppliedKind = 'WORKORDER' AND app.appliedId IN (
            SELECT wo.id FROM workOrders wo WHERE wo.invoiceId = ${input.invoiceId}
          ))
        )
        AND (pr.id IS NULL OR pr.invoiceId IS NULL OR pr.invoiceId <> ${input.invoiceId})
      GROUP BY coll.orderPayMethod
    `);
    const appData = (appRes as unknown as [Array<{ method: string; net: string }>])[0] ?? appRes;
    const paidMap = new Map<string, Decimal>();
    for (const r of pmRows) {
      if (!r.method) continue;
      paidMap.set(r.method, (paidMap.get(r.method) ?? money(0)).plus(money(r.net)));
    }
    for (const r of (Array.isArray(appData) ? appData : []) as Array<{ method: string; net: string }>) {
      if (!r.method) continue;
      paidMap.set(r.method, (paidMap.get(r.method) ?? money(0)).plus(money(r.net)));
    }
    const paidByMethod: Array<{ method: string; amount: string }> = [];
    paidMap.forEach((v, m) => {
      if (v.gt(0)) paidByMethod.push({ method: m, amount: v.toFixed(2) });
    });

    return {
      id: Number(inv.id),
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      branchId: Number(inv.branchId),
      customerId: inv.customerId === null ? null : Number(inv.customerId),
      customerName: inv.customerName ?? null,
      subtotal: inv.subtotal,
      discountAmount: inv.discountAmount,
      taxAmount: inv.taxAmount,
      total: inv.total,
      paidAmount: inv.paidAmount,
      paymentMethod: inv.paymentMethod,
      paidByMethod,
      items,
    };
  }),
});
