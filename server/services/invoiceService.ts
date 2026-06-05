import { getDb } from "../db";
import { invoices, invoiceItems, products, customers, receipts, printJobs } from "../../drizzle/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { printingService } from "./printingService";

export interface CreateInvoiceInput {
  customerId: number;
  sourceType: "POS" | "ONLINE" | "ORDER";
  sourceId?: string;
  items: Array<{
    productId: number;
    quantity: number;
    unitPrice: number;
    discountPercent?: number;
  }>;
  taxPercent?: number;
  discountAmount?: number;
  paymentMethod?: string;
  notes?: string;
  createdBy: number;
}

export interface ProcessPaymentInput {
  invoiceId: number;
  amount: number;
  paymentMethod: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
  referenceNumber?: string;
  checkNumber?: string;
  cardLastFour?: string;
  createdBy: number;
}

export class InvoiceService {
  async createInvoice(input: CreateInvoiceInput) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      // التحقق من المنتجات والمخزون
      for (const item of input.items) {
        const product = await db
          .select()
          .from(products)
          .where(eq(products.id, item.productId))
          .limit(1);

        if (!product.length) {
          throw new Error(`Product ${item.productId} not found`);
        }

        if (product[0].quantityOnHand < item.quantity) {
          throw new Error(
            `Insufficient stock for product ${product[0].name}. Available: ${product[0].quantityOnHand}, Requested: ${item.quantity}`
          );
        }
      }

      // حساب الإجماليات
      let subtotal = 0;
      const calculatedItems = input.items.map((item) => {
        const itemTotal = item.quantity * item.unitPrice;
        const discountAmount = (itemTotal * (item.discountPercent || 0)) / 100;
        const itemSubtotal = itemTotal - discountAmount;
        subtotal += itemSubtotal;

        return {
          ...item,
          discountAmount,
          total: itemSubtotal,
        };
      });

      const taxAmount = (subtotal * (input.taxPercent || 15)) / 100;
      const total = subtotal + taxAmount - (input.discountAmount || 0);

      // إنشاء الفاتورة
      const invoiceNumber = await this.generateInvoiceNumber();

      const invoiceResult = await db
        .insert(invoices)
        .values({
          invoiceNumber,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          customerId: input.customerId,
          subtotal: subtotal.toString(),
          taxAmount: taxAmount.toString(),
          discountAmount: (input.discountAmount || 0).toString(),
          total: total.toString(),
          status: "PENDING",
          paidAmount: "0",
          paymentMethod: input.paymentMethod,
          notes: input.notes,
          createdBy: input.createdBy,
        });

      const invoiceId = invoiceResult[0].insertId;

      // إضافة عناصر الفاتورة
      for (const item of calculatedItems) {
        await db.insert(invoiceItems).values({
          invoiceId: invoiceId as any,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          discountPercent: (item.discountPercent || 0).toString(),
          discountAmount: item.discountAmount.toString(),
          total: item.total.toString(),
        });
      }

      // تحديث المخزون
      for (const item of calculatedItems) {
        const product = await db
          .select()
          .from(products)
          .where(eq(products.id, item.productId))
          .limit(1);

        if (product.length) {
          const newQuantity = product[0].quantityOnHand - item.quantity;
          await db
            .update(products)
            .set({ quantityOnHand: newQuantity })
            .where(eq(products.id, item.productId));
        }
      }

      // إنشاء وظيفة طباعة
      await db.insert(printJobs).values({
        invoiceId: invoiceId as any,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 3,
      });

      // إرسال للطباعة
      const customer = await db
        .select()
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .limit(1);

      const itemsWithNames = await Promise.all(
        calculatedItems.map(async (item) => {
          const product = await db
            .select()
            .from(products)
            .where(eq(products.id, item.productId))
            .limit(1);

          return {
            name: product[0]?.name || "Unknown",
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.total,
          };
        })
      );

      await printingService.addToPrintQueue({
        id: invoiceId as any,
        invoiceNumber,
        customerName: customer[0]?.name || "Unknown",
        items: itemsWithNames,
        subtotal,
        taxAmount,
        total,
        paymentMethod: input.paymentMethod || "CASH",
        createdAt: new Date(),
      });

      return {
        invoiceId,
        invoiceNumber,
        total,
        status: "PENDING",
      };
    } catch (error) {
      console.error("[InvoiceService] Error creating invoice:", error);
      throw error;
    }
  }

  async processPayment(input: ProcessPaymentInput) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const invoice = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .limit(1);

      if (!invoice.length) {
        throw new Error("Invoice not found");
      }

      const inv = invoice[0];
      const currentPaid = parseFloat(inv.paidAmount || "0");
      const invoiceTotal = parseFloat(inv.total);
      const newPaidAmount = currentPaid + input.amount;

      if (newPaidAmount > invoiceTotal) {
        throw new Error("Payment amount exceeds invoice total");
      }

      const receiptResult = await db.insert(receipts).values({
        invoiceId: input.invoiceId,
        amount: input.amount.toString(),
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber,
        checkNumber: input.checkNumber,
        cardLastFour: input.cardLastFour,
        status: "COMPLETED",
        createdBy: input.createdBy,
      });

      let newStatus = "PARTIALLY_PAID";
      if (newPaidAmount >= invoiceTotal) {
        newStatus = "PAID";
      }

      await db
        .update(invoices)
        .set({
          paidAmount: newPaidAmount.toString(),
          status: newStatus as any,
          paymentDate: new Date(),
        })
        .where(eq(invoices.id, input.invoiceId));

      return {
        receiptId: receiptResult[0].insertId,
        invoiceId: input.invoiceId,
        paidAmount: newPaidAmount,
        remaining: Math.max(0, invoiceTotal - newPaidAmount),
        status: newStatus,
      };
    } catch (error) {
      console.error("[InvoiceService] Error processing payment:", error);
      throw error;
    }
  }

  async getInvoiceDetails(invoiceId: number) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const invoice = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1);

      if (!invoice.length) {
        throw new Error("Invoice not found");
      }

      const items = await db
        .select()
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, invoiceId));

      const customer = await db
        .select()
        .from(customers)
        .where(eq(customers.id, invoice[0].customerId))
        .limit(1);

      return {
        ...invoice[0],
        items,
        customer: customer[0] || null,
      };
    } catch (error) {
      console.error("[InvoiceService] Error getting invoice details:", error);
      throw error;
    }
  }

  async listInvoices(limit: number = 50, offset: number = 0) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const result = await db
        .select()
        .from(invoices)
        .orderBy(desc(invoices.invoiceDate))
        .limit(limit)
        .offset(offset);

      return result;
    } catch (error) {
      console.error("[InvoiceService] Error listing invoices:", error);
      throw error;
    }
  }

  private async generateInvoiceNumber(): Promise<string> {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const timestamp = Date.now().toString().slice(-6);

    return `INV-${year}${month}${day}-${timestamp}`;
  }

  async getDailyStatistics(date: Date) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const dailyInvoices = await db
        .select()
        .from(invoices)
        .where(
          and(
            gte(invoices.invoiceDate, startOfDay),
            lte(invoices.invoiceDate, endOfDay)
          )
        );

      const totalSales = dailyInvoices.reduce(
        (sum, inv) => sum + parseFloat(inv.total),
        0
      );
      const totalPaid = dailyInvoices.reduce(
        (sum, inv) => sum + parseFloat(inv.paidAmount || "0"),
        0
      );
      const totalTax = dailyInvoices.reduce(
        (sum, inv) => sum + parseFloat(inv.taxAmount),
        0
      );

      return {
        date: date.toISOString().split("T")[0],
        invoiceCount: dailyInvoices.length,
        totalSales,
        totalPaid,
        totalTax,
        averageInvoiceValue:
          dailyInvoices.length > 0 ? totalSales / dailyInvoices.length : 0,
        paidInvoices: dailyInvoices.filter((inv) => inv.status === "PAID")
          .length,
        pendingInvoices: dailyInvoices.filter((inv) => inv.status === "PENDING")
          .length,
      };
    } catch (error) {
      console.error("[InvoiceService] Error calculating daily statistics:", error);
      throw error;
    }
  }
}

export const invoiceService = new InvoiceService();
