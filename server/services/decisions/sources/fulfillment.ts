import { and, asc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { branches, customers } from "../../../../drizzle/schema";
import {
  aftercareCases,
  aftercareSettlements,
  fulfillmentCharges,
} from "../../../../drizzle/fulfillmentSchema";
import { operationDecision } from "../../../../shared/operationPermissions";
import { appErrorMessage } from "../../../../shared/errors";
import { loadOperationUserTx } from "../../authorization/operationAuthority";
import { fulfillmentCostVisibleTx } from "../../fulfillment/visibility";
import { requireDb, withTx } from "../../tx";
import { serviceActor } from "../gate";
import { buildRow } from "../rows";
import type { DecisionSource } from "../types";
import { freshnessFrom, scopeBranch } from "./common";
import { money } from "../../money";

type Mode = "review" | "followup" | "settlement" | "charge";
const kinds = {
  review: "delivery.fulfillment.aftercare.approve",
  followup: "delivery.fulfillment.aftercare.followup",
  settlement: "delivery.fulfillment.aftercare.settlementApprove",
  charge: "delivery.fulfillment.charges.approve",
} as const;
function source(mode: Mode): DecisionSource {
  return {
    key: `delivery.fulfillment.${mode}`,
    kinds: [kinds[mode]],
    gate: { type: "MODULE_MAP", moduleKey: "store", branchScoped: true },
    // Evidence-rich decisions/preparation execute in their original flat station.
    supportedActions: [],
    async list(actor, scope) {
      const branchId = scopeBranch(actor, scope);
      if (branchId === "NONE") return [];
      const domain = serviceActor(actor);
      const authority = await withTx(
        async (tx) => ({
          user: await loadOperationUserTx(tx, actor.userId),
          costVisible:
            mode === "charge"
              ? await fulfillmentCostVisibleTx(tx, domain)
              : false,
        }),
        { gate: "NONE" },
      );
      const can = (path: string) =>
        operationDecision(authority.user, path).allowed;
      const base = {
        kind: kinds[mode],
        allowedActions: [],
        rejectReason: "NOT_SUPPORTED" as const,
        openActionLabel:
          mode === "followup"
            ? "استكمال في محطة المعالجة"
            : "فتح الأصل والمراجعة في المحطة",
      };
      const db = requireDb();
      if (mode === "charge") {
        if (
          !can("delivery.fulfillment.charges.approve") ||
          !authority.costVisible
        )
          return [];
        const rows = await db
          .select({
            charge: fulfillmentCharges,
            party: customers.name,
            branch: branches.name,
          })
          .from(fulfillmentCharges)
          .leftJoin(customers, eq(customers.id, fulfillmentCharges.customerId))
          .leftJoin(branches, eq(branches.id, fulfillmentCharges.branchId))
          .where(
            and(
              eq(fulfillmentCharges.status, "DRAFT"),
              branchId == null
                ? undefined
                : eq(fulfillmentCharges.branchId, branchId),
            ),
          )
          .orderBy(asc(fulfillmentCharges.createdAt));
        return rows
          .filter(
            ({ charge }) =>
              money(charge.externalCost).isZero() ||
              charge.createdBy !== actor.userId,
          )
          .map(({ charge, party, branch }) =>
            buildRow(
              {
                ...base,
                id: charge.id,
                title: `مراجعة الأجر · ${charge.description}`,
                party,
                amount: charge.amount,
                branchId: charge.branchId,
                branchName: branch,
                requestedBy: charge.createdBy,
                requestedAt: charge.createdAt,
                reason: charge.reason,
                expectedVersion: charge.version,
                summaryItems: [
                  { label: charge.description, unitPrice: charge.amount },
                  { label: "التكلفة الخارجية", unitPrice: charge.externalCost },
                ],
              },
              scope.now,
            ),
          );
      }
      if (mode === "settlement") {
        if (!can("delivery.fulfillment.aftercare.settlementApprove")) return [];
        const rows = await db
          .select({
            settlement: aftercareSettlements,
            number: aftercareCases.caseNumber,
            branch: branches.name,
          })
          .from(aftercareSettlements)
          .innerJoin(
            aftercareCases,
            eq(aftercareCases.id, aftercareSettlements.caseId),
          )
          .leftJoin(branches, eq(branches.id, aftercareSettlements.branchId))
          .where(
            and(
              eq(aftercareSettlements.status, "REQUESTED"),
              branchId == null
                ? undefined
                : eq(aftercareSettlements.branchId, branchId),
            ),
          )
          .orderBy(asc(aftercareSettlements.createdAt));
        return rows
          .filter(({ settlement }) => settlement.createdBy !== actor.userId)
          .map(({ settlement, number, branch }) =>
            buildRow(
              {
                ...base,
                id: settlement.id,
                hrefId: settlement.caseId,
                title: `تسوية المعالجة · ${number}`,
                branchId: settlement.branchId,
                branchName: branch,
                requestedBy: settlement.createdBy,
                requestedAt: settlement.createdAt,
                expectedVersion: settlement.version,
                reason: settlement.reason,
                summaryItems: [
                  { label: settlement.evidence },
                  { label: "راجع الكميات والأصل والعهدة قبل اعتماد التسوية" },
                ],
              },
              scope.now,
            ),
          );
      }
      if (
        mode === "review"
          ? !can("delivery.fulfillment.aftercare.approve")
          : ![
              "prepare",
              "dispatch",
              "resolve",
              "settlementPost",
              "payFee",
            ].some((action) => can(`delivery.fulfillment.aftercare.${action}`))
      )
        return [];
      const rows = await db
        .select({
          item: aftercareCases,
          party: customers.name,
          branch: branches.name,
        })
        .from(aftercareCases)
        .leftJoin(customers, eq(customers.id, aftercareCases.customerId))
        .leftJoin(branches, eq(branches.id, aftercareCases.branchId))
        .where(
          and(
            inArray(
              aftercareCases.status,
              mode === "review" ? ["DRAFT"] : ["APPROVED", "IN_PROGRESS"],
            ),
            branchId == null
              ? undefined
              : eq(aftercareCases.branchId, branchId),
          ),
        )
        .orderBy(asc(aftercareCases.createdAt));
      return rows
        .filter(
          ({ item }) => mode !== "review" || item.createdBy !== actor.userId,
        )
        .map(({ item, party, branch }) =>
          buildRow(
            {
              ...base,
              id: item.id,
              title: `${mode === "review" ? "مراجعة" : "استكمال"} المعالجة · ${item.caseNumber}`,
              party,
              branchId: item.branchId,
              branchName: branch,
              requestedBy: item.createdBy,
              requestedAt: item.createdAt,
              expectedVersion: item.version,
              reason: item.reason,
              summaryItems: [
                { label: item.evidence },
                {
                  label:
                    mode === "review"
                      ? "اعتماد مستقل قبل صرف البديل أو الخامات"
                      : "التجهيز والتوصيل والعهدة وحق العميل من نفس المحطة",
                },
              ],
            },
            scope.now,
          ),
        );
    },
    freshness: (id) =>
      freshnessFrom(
        async () => {
          const db = requireDb();
          if (mode === "charge")
            return (
              await db
                .select({ status: fulfillmentCharges.status })
                .from(fulfillmentCharges)
                .where(eq(fulfillmentCharges.id, id))
                .limit(1)
            )[0]?.status;
          if (mode === "settlement")
            return (
              await db
                .select({ status: aftercareSettlements.status })
                .from(aftercareSettlements)
                .where(eq(aftercareSettlements.id, id))
                .limit(1)
            )[0]?.status;
          return (
            await db
              .select({ status: aftercareCases.status })
              .from(aftercareCases)
              .where(eq(aftercareCases.id, id))
              .limit(1)
          )[0]?.status;
        },
        mode === "charge" || mode === "review"
          ? ["DRAFT"]
          : mode === "settlement"
            ? ["REQUESTED"]
            : ["APPROVED", "IN_PROGRESS"],
      ),
    async decide() {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "أكمل الإجراء من بطاقة الأصل",
          why: "المراجعة تحتاج دليل المصدر والكميات وحالة العهدة الحالية",
          doThis: "افتح المحطة من رابط الصف وأكمل الإجراء المسموح",
        }),
      });
    },
  };
}
export const FULFILLMENT_SOURCES: readonly DecisionSource[] = [
  source("review"),
  source("settlement"),
  source("charge"),
  source("followup"),
];
