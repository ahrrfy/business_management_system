import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { offeringService, providerService } from "../digitalCards";

const OWN_BRANCH_ID = 1;
const FOREIGN_BRANCH_ID = 2;
const OWN_INVOICE_ID = 101;
const FOREIGN_INVOICE_ID = 102;
const actor = { userId: 1, branchId: OWN_BRANCH_ID };

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

function caller(role: "cashier" | "accountant") {
  const userId = role === "cashier" ? 2 : 1;
  const context = {
    req: { headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: {
      id: userId,
      openId: `route-${role}`,
      name: role,
      email: `${role}@route.test`,
      role,
      branchId: OWN_BRANCH_ID,
      loginMethod: "local",
      isActive: true,
    } as TrpcContext["user"],
    sessionId: null,
    authenticationError: null,
    platformAdmin: null,
  } as TrpcContext;
  return appRouter.createCaller(context);
}

async function createOfferingForBranch(providerId: number, branchId: number, name: string) {
  return withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: "TELECOM_CARD",
        name,
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "500",
        roundingStep: "250",
        branches: [{ branchId }],
      },
      actor,
    ),
  );
}

let ownOfferingId = 0;
let foreignOfferingId = 0;

beforeEach(async () => {
  await db().insert(s.branches).values([
    { id: OWN_BRANCH_ID, name: "Own branch", code: "DC-OWN", type: "MAIN" },
    { id: FOREIGN_BRANCH_ID, name: "Foreign branch", code: "DC-FOREIGN", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    {
      id: 1,
      openId: "route-accountant",
      name: "Accountant",
      email: "accountant@route.test",
      role: "accountant",
      branchId: OWN_BRANCH_ID,
      loginMethod: "local",
    },
    {
      id: 2,
      openId: "route-cashier",
      name: "Cashier",
      email: "cashier@route.test",
      role: "cashier",
      branchId: OWN_BRANCH_ID,
      loginMethod: "local",
    },
  ]);
  await db().insert(s.invoices).values([
    {
      id: OWN_INVOICE_ID,
      invoiceNumber: "DC-ROUTE-OWN",
      sourceType: "POS",
      branchId: OWN_BRANCH_ID,
      subtotal: "0",
      total: "0",
      status: "PAID",
      createdBy: 2,
    },
    {
      id: FOREIGN_INVOICE_ID,
      invoiceNumber: "DC-ROUTE-FOREIGN",
      sourceType: "POS",
      branchId: FOREIGN_BRANCH_ID,
      subtotal: "0",
      total: "0",
      status: "PAID",
      createdBy: 2,
    },
  ]);

  const { supplierId } = await createSupplier({ name: "Route isolation provider" }, actor);
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "TELECOM",
        settlementMode: "POSTPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      actor,
    ),
  );
  ownOfferingId = (
    await createOfferingForBranch(providerId, OWN_BRANCH_ID, "Own branch digital card")
  ).offeringId;
  foreignOfferingId = (
    await createOfferingForBranch(providerId, FOREIGN_BRANCH_ID, "Foreign branch digital card")
  ).offeringId;
});

describe("digital-card route branch isolation", () => {
  it("sales.printDetails allows the caller's invoice and rejects another branch's invoice", async () => {
    const pos = caller("cashier").digitalCards.sales;

    await expect(pos.printDetails({ invoiceId: OWN_INVOICE_ID })).resolves.toEqual([]);
    await expect(pos.printDetails({ invoiceId: FOREIGN_INVOICE_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("sales.saleDetails allows the caller's invoice and rejects another branch's invoice", async () => {
    const sales = caller("accountant").digitalCards.sales;

    await expect(sales.saleDetails({ invoiceId: OWN_INVOICE_ID })).resolves.toEqual([]);
    await expect(sales.saleDetails({ invoiceId: FOREIGN_INVOICE_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("reversal.reversible allows the caller's invoice and rejects another branch's invoice", async () => {
    const reversal = caller("accountant").digitalCards.reversal;

    await expect(reversal.reversible({ invoiceId: OWN_INVOICE_ID })).resolves.toEqual([]);
    await expect(reversal.reversible({ invoiceId: FOREIGN_INVOICE_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("offerings.get allows a linked offering and rejects an offering linked only to another branch", async () => {
    const offerings = caller("accountant").digitalCards.offerings;

    await expect(offerings.get({ id: ownOfferingId })).resolves.toMatchObject({ id: ownOfferingId });
    await expect(offerings.get({ id: foreignOfferingId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
