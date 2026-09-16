// Local browser fixture only. Run with node --import tsx; never touches production.
import "dotenv/config";
import { eq } from "drizzle-orm";
import * as s from "../drizzle/schema.ts";
import { getDb } from "../server/db.ts";
import { hashPassword } from "../server/auth/password.ts";
import { createSupplier } from "../server/services/supplierService.ts";
import { withTx } from "../server/services/tx.ts";
import { offeringService, pricingService, providerService, walletService } from "../server/services/digitalCards/index.ts";

const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (url.hostname !== "127.0.0.1" || url.port !== "3310" || url.pathname !== "/erp_digital_card_baskets_api_test" || process.env.NODE_ENV !== "development") {
  throw new Error("Only the isolated digital baskets browser fixture database is allowed");
}
const password = process.env.DIGITAL_BASKET_SMOKE_PASSWORD;
if (!password || password.length < 16) throw new Error("Set a local-only smoke password of at least 16 characters");
const db = getDb();
if (!db) throw new Error("Missing local fixture database");
if ((await db.select({ id: s.users.id }).from(s.users).limit(1)).length) throw new Error("Fixture requires an empty database; existing data preserved");
const actor = { userId: 1, branchId: 1, role: "admin" };
await db.insert(s.branches).values({ id: 1, name: "فرع تجربة السلة", code: "MAIN", type: "MAIN" });
await db.insert(s.users).values({
  id: 1, openId: "digital-baskets-local", name: "اختبار سلة البطاقات", email: "baskets@test.local",
  passwordHash: await hashPassword(password), role: "admin", loginMethod: "local", branchId: 1,
  sessionsValidFrom: new Date(Date.now() - 2000),
});
await db.insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0", shiftType: "RETAIL" });
await db.insert(s.customers).values({ id: 1, name: "عميل تجربة السلة", branchId: 1, defaultPriceTier: "RETAIL" });
await db.insert(s.products).values({ id: 1, name: "دفتر اختبار السلة", invoiceLabel: "دفتر مدرسي" });
await db.insert(s.productVariants).values({ id: 1, productId: 1, sku: "BASKET-BOOK", costPrice: "1000" });
await db.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
await db.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "2000" });
await db.insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 20 });
const { supplierId } = await createSupplier({ name: "مزود تجربة السلة" }, actor);
const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
  supplierId, providerType: "TELECOM", settlementMode: "PREPAID", recognitionMode: "PRINCIPAL_GROSS",
  referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
}, actor));
const { walletId } = await withTx((tx) => walletService.createWallet(tx, { providerId, branchId: 1, code: "SMOKE", name: "جهاز اختبار محلي" }, actor));
await db.update(s.digitalWallets).set({ currentBalance: "1000000" }).where(eq(s.digitalWallets.id, walletId));
const specs = [
  { name: "كارت اتصالات عشرة آلاف", offeringType: "TELECOM_CARD", faceValue: "10000", providerShare: "9500" },
  { name: "كارت اتصالات عشرون ألفاً", offeringType: "TELECOM_CARD", faceValue: "20000", providerShare: "19500" },
  { name: "اشتراك تعليمي ثلاثون يوماً", offeringType: "EDUCATIONAL_SUBSCRIPTION", requiresStudentData: true, subscriptionDurationDays: 30, providerShare: "29500" },
];
const lines = [];
for (const { providerShare, ...spec } of specs) {
  const { offeringId } = await withTx((tx) => offeringService.createOffering(tx, {
    ...spec, providerId, pricingMode: "FIXED_MARGIN", fixedMargin: "500", roundingStep: "0",
    branches: [{ branchId: 1, walletId }],
  }, actor));
  lines.push({ offeringId, providerShare });
}
const { batchId } = await withTx((tx) => pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: new Date().toISOString().slice(0, 10) }, actor));
await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines }, actor));
await withTx((tx) => pricingService.publish(tx, { batchId }, actor));
console.log("Local browser fixture ready: one provider, three offerings, ordinary product, customer, open shift.");
process.exit(0);
