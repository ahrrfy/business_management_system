/**
 * مصادرُ المخزون: تسويةُ الرصيد وإعادةُ تقييم التكلفة — بوّابة `inventoryManagerProcedure`
 * (`moduleProcedure(["manager"], "inventory", "FULL")`)، والحسمُ بدوالّ الخدمة نفسها.
 */
import { eq } from "drizzle-orm";
import { costRevaluationApprovalTrigger, stockAdjustmentApprovalTrigger } from "@shared/approvalTriggers";
import { decisionSubkindLabel } from "@shared/decisionRegistry";
import { costRevaluationRequests, stockAdjustmentRequests } from "../../../../drizzle/schema";
import {
  approveStockAdjustment,
  listStockAdjustmentRequests,
  rejectStockAdjustment,
} from "../../inventory/adjustmentApproval";
import {
  approveCostRevaluation,
  listCostRevaluations,
  rejectCostRevaluation,
} from "../../inventory/costRevaluationRequest";
import { requireDb } from "../../tx";
import { serviceActor } from "../gate";
import { buildRow, decided, defaultMessage, itemLabel } from "../rows";
import type { DecisionSource } from "../types";
import { branchNames, freshnessFrom, ids, scopeBranch, sodHidden } from "./common";

/**
 * [`inventoryRouter.ts:430`](../../../routers/inventoryRouter.ts) ⇐ `approveStockAdjustment`.
 * فصلُ المهام في الخدمة: الطالب لا يعتمد طلبه إلّا إن كان admin (`assertIndependentInventoryReviewer`).
 */
export const stockAdjustmentSource: DecisionSource = {
  key: "inventory.adjustment",
  kinds: ["inventory.adjustment.approve", "inventory.adjustment.reject"],
  gate: { type: "MODULE", moduleKey: "inventory", roles: ["manager"] },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const rows = await listStockAdjustmentRequests({ branchId, status: "PENDING_APPROVAL", order: "ASC" });
    const names = await branchNames(requireDb(), ids(rows.map((r) => r.branchId)));
    return rows
      .filter((r) => !sodHidden({ blocked: [r.createdBy], actor, adminExempt: true, trigger: "ERASE_EFFECT" }))
      .map((r) => {
        const current = Number(r.currentQuantity ?? r.expectedQuantity ?? 0);
        const target = Number(r.targetQuantity);
        return buildRow(
          {
            kind: "inventory.adjustment.approve",
            id: Number(r.id),
            title: `تسوية مخزون · ${itemLabel([r.productName, r.variantName, r.sku])}`,
            subkind: r.reason ? String(r.reason) : null,
            branchId: Number(r.branchId),
            branchName: names.get(Number(r.branchId)) ?? null,
            requestedBy: r.createdBy == null ? null : Number(r.createdBy),
            requestedByName: r.createdByName ?? null,
            requestedAt: r.createdAt,
            summaryItems: [
              { label: itemLabel([r.productName, r.variantName]), qty: `${current} → ${target}`, unit: "بالوحدة الأساس" },
              { label: "الفرق", qty: target - current },
            ],
            reason: r.notes ?? null,
            trigger: stockAdjustmentApprovalTrigger("APPROVE"),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () =>
        (
          await requireDb()
            .select({ status: stockAdjustmentRequests.status })
            .from(stockAdjustmentRequests)
            .where(eq(stockAdjustmentRequests.id, id))
            .limit(1)
        )[0]?.status,
      ["PENDING_APPROVAL"],
    ),
  async decide(input, actor) {
    const subject = `تسوية المخزون رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectStockAdjustment(input.id, serviceActor(actor), input.reason ?? "");
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveStockAdjustment(input.id, serviceActor(actor));
    return decided(
      input,
      "EXECUTED",
      `${subject}: اعتُمدت — الرصيد الجديد ${res.newQuantity} (فرق ${res.delta > 0 ? "+" : ""}${res.delta}).`,
    );
  },
};

/**
 * [`inventoryRouter.ts:543`](../../../routers/inventoryRouter.ts) ⇐ `approveCostRevaluation`.
 * نفسُ فصل المهام المحلّيّ (الطالب لا يعتمد إلّا admin).
 */
export const costRevaluationSource: DecisionSource = {
  key: "inventory.costRevaluation",
  kinds: ["inventory.costRevaluation.approve", "inventory.costRevaluation.reject"],
  gate: { type: "MODULE", moduleKey: "inventory", roles: ["manager"] },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const rows = await listCostRevaluations({ status: "PENDING_APPROVAL", branchId, limit: 200, order: "ASC" }, serviceActor(actor));
    return rows
      .filter((r) => !sodHidden({ blocked: [r.createdBy], actor, adminExempt: true, trigger: "ERASE_EFFECT" }))
      .map((r) =>
        buildRow(
          {
            kind: "inventory.costRevaluation.approve",
            id: r.id,
            title: `اعادة تقييم تكلفة · ${itemLabel([r.productName, r.variantLabel])}`,
            subkind: decisionSubkindLabel(r.purpose),
            amount: r.expectedValueDelta,
            branchId: r.branchId,
            branchName: r.branchName,
            requestedBy: r.createdBy,
            requestedByName: r.createdByName,
            requestedAt: r.createdAt,
            summaryItems: [
              { label: "التكلفة الحالية", unitPrice: r.oldCost },
              { label: "التكلفة الجديدة", unitPrice: r.newCost },
              { label: "الكمية المتأثرة", qty: r.expectedQuantity, unit: "بالوحدة الأساس" },
            ],
            reason: r.reason,
            trigger: costRevaluationApprovalTrigger("APPROVE"),
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(
      async () =>
        (
          await requireDb()
            .select({ status: costRevaluationRequests.status })
            .from(costRevaluationRequests)
            .where(eq(costRevaluationRequests.id, id))
            .limit(1)
        )[0]?.status,
      ["PENDING_APPROVAL"],
    ),
  async decide(input, actor) {
    const subject = `اعادة تقييم التكلفة رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectCostRevaluation(input.id, serviceActor(actor), input.reason ?? "");
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveCostRevaluation(input.id, serviceActor(actor));
    return decided(
      input,
      "EXECUTED",
      `${subject}: اعتُمدت — التكلفة الجديدة ${res.newCost} وقيود مرحلة ${res.postedEntries}.`,
    );
  },
};
