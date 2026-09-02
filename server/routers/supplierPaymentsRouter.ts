import { z } from "zod";
import { positiveMoneyString, positiveRateString } from "../lib/schemas";
import {
  decideSupplierPayment,
  decideSupplierPaymentRefund,
  listPendingSupplierPaymentRefundRequests,
  listPendingSupplierPaymentRequests,
  listSupplierPaymentRefundSources,
  listSupplierPaymentSources,
  requestSupplierPayment,
  requestSupplierPaymentRefund,
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
} from "../services/purchase/supplierPayments";
import {
  purchasesManagerProcedure,
  purchasesReadProcedure,
  router,
  treasuryManagerProcedure,
} from "../trpc";

const actor = (ctx: {
  user: { id: number; branchId?: number | null; role?: string };
}) => ({
  userId: ctx.user.id,
  branchId: Number(ctx.user.branchId ?? 0),
  role: ctx.user.role,
});
const key = z.string().trim().min(1).max(120);
const reason = z.string().trim().min(3).max(500);
const method = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);
const sourcePageCommon = {
  branchId: z.number().int().positive(),
  supplierId: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).default(100),
} as const;

export const supplierPaymentsRouter = router({
  requestPayment: purchasesManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        requestKey: key,
        currency: z.enum(["IQD", "USD"]),
        exchangeRate: positiveRateString.nullish(),
        amount: positiveMoneyString,
        currencyAmount: positiveMoneyString,
        paymentMethod: method,
        externalReference: z.string().trim().max(160).nullish(),
        evidenceType: z.enum([
          "PAYMENT_ORDER",
          "BANK_ADVICE",
          "TRANSFER_RECEIPT",
          "CASH_ACKNOWLEDGEMENT",
          "DOCUMENT_IMAGE",
          "PDF",
          "OTHER",
        ]),
        evidenceReference: z.string().trim().min(1).max(500),
        reason,
        allocations: z
          .array(
            z.object({
              supplierInvoiceId: z.number().int().positive(),
              invoiceVersion: z.number().int().positive(),
              amount: positiveMoneyString,
              currencyAmount: positiveMoneyString,
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .mutation(({ input, ctx }) => requestSupplierPayment(input, actor(ctx))),
  decidePayment: treasuryManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        decisionKey: key,
        action: z.enum(["APPROVE", "REJECT"]),
        reviewReason: reason,
      }),
    )
    .mutation(({ input, ctx }) =>
      decideSupplierPayment(
        input,
        actor(ctx),
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      ),
    ),
  requestRefund: purchasesManagerProcedure
    .input(
      z.object({
        supplierPaymentId: z.number().int().positive(),
        expectedPaymentVersion: z.number().int().positive(),
        requestKey: key,
        refundMethod: method,
        externalReference: z.string().trim().max(160).nullish(),
        evidenceType: z.enum([
          "SUPPLIER_ACKNOWLEDGEMENT",
          "BANK_ADVICE",
          "TRANSFER_RECEIPT",
          "CASH_RECEIPT",
          "DOCUMENT_IMAGE",
          "PDF",
          "OTHER",
        ]),
        evidenceReference: z.string().trim().min(1).max(500),
        reason,
        allocations: z
          .array(
            z.object({
              supplierPaymentAllocationId: z.number().int().positive(),
              amount: positiveMoneyString,
              currencyAmount: positiveMoneyString,
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      requestSupplierPaymentRefund(input, actor(ctx)),
    ),
  decideRefund: treasuryManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        decisionKey: key,
        action: z.enum(["APPROVE", "REJECT"]),
        reviewReason: reason,
      }),
    )
    .mutation(({ input, ctx }) =>
      decideSupplierPaymentRefund(
        input,
        actor(ctx),
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      ),
    ),
  pendingPayments: purchasesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      listPendingSupplierPaymentRequests(input.branchId, actor(ctx)),
    ),
  pendingRefunds: purchasesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z
          .object({
            requestedAt: z.coerce.date(),
            id: z.number().int().positive(),
          })
          .optional(),
      }),
    )
    .query(({ input, ctx }) =>
      listPendingSupplierPaymentRefundRequests(input, actor(ctx)),
    ),
  paymentSources: purchasesReadProcedure
    .input(
      z.object({
        ...sourcePageCommon,
        cursor: z.object({
          invoiceDate: z.string().date(),
          id: z.number().int().positive(),
        }).optional(),
      }),
    )
    .query(({ input, ctx }) => listSupplierPaymentSources(input, actor(ctx))),
  refundSources: purchasesReadProcedure
    .input(
      z.object({
        ...sourcePageCommon,
        cursor: z.object({
          postedAt: z.coerce.date(),
          id: z.number().int().positive(),
        }).optional(),
      }),
    )
    .query(({ input, ctx }) =>
      listSupplierPaymentRefundSources(input, actor(ctx)),
    ),
});
