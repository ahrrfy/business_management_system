// E2E تحقّق نهائي ١٠٠٪ من ٦ شاشات الإضافة v3 — إنشاء فعلي عبر API ثم قراءة من DB.
import mysql from "mysql2/promise";

const TS = Date.now();
const last6 = String(TS).slice(-6);
const BASE = process.env.E2E_BASE || "http://localhost:3004";
const DB_URL = process.env.E2E_DB || "mysql://root:erp_root_pw@127.0.0.1:3306/erp_add_screens";
let COOKIE = "";

async function call(path, body) {
  const headers = { "Content-Type": "application/json", "Origin": BASE };
  if (COOKIE) headers["Cookie"] = COOKIE;
  const r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) COOKIE = setCookie.split(";")[0];
  return r.json();
}

async function getCall(path, input) {
  const headers = { "Origin": BASE };
  if (COOKIE) headers["Cookie"] = COOKIE;
  const url = BASE + path + "?batch=1&input=" + encodeURIComponent(JSON.stringify({ "0": { json: input } }));
  const r = await fetch(url, { headers });
  return r.json();
}

const report = [];
function check(label, ok, extra = "") {
  report.push({ label, ok, extra });
  console.log((ok ? "✓" : "✗") + " " + label + (extra ? " — " + extra : ""));
}

const login = await call("/api/trpc/auth.login?batch=1", { "0": { json: { email: "admin@alroya.local", password: "Admin@12345" } } });
check("LOGIN", !!login[0]?.result);

// 1. CUSTOMER
const cu = await call("/api/trpc/customers.create?batch=1", { "0": { json: {
  name: "E2E-Customer-" + TS,
  phone: "+96477001" + last6, phone2: "+96477002" + last6, phone3: "+96477003" + last6,
  whatsapp: "+96477001" + last6, address: "بغداد كرادة", city: "بغداد",
  customerType: "تاجر", defaultPriceTier: "WHOLESALE", creditLimit: "500000",
} } });
const customerId = cu[0]?.result?.data?.json?.customerId;
check("CUSTOMER created", !!customerId, "id=" + customerId);
const cuGet = await getCall("/api/trpc/customers.get", { customerId });
const cuData = cuGet[0]?.result?.data?.json;
check("CUSTOMER 3-phones saved", !!(cuData?.phone && cuData?.phone2 && cuData?.phone3),
  "p=" + cuData?.phone + " p2=" + cuData?.phone2 + " p3=" + cuData?.phone3);
check("CUSTOMER type/tier/credit", cuData?.customerType === "تاجر" && cuData?.defaultPriceTier === "WHOLESALE" && cuData?.creditLimit === "500000.00",
  "type=" + cuData?.customerType + " tier=" + cuData?.defaultPriceTier + " credit=" + cuData?.creditLimit);

// 2. SUPPLIER
const su = await call("/api/trpc/suppliers.create?batch=1", { "0": { json: {
  name: "E2E-Supplier-" + TS,
  phone: "+96477011" + last6, phone2: "+96477012" + last6, phone3: "+96477013" + last6,
  whatsapp: "+96477011" + last6, address: "بغداد", city: "بغداد",
  supplierCategory: "محلي", leadTimeDays: 7, minOrderAmount: "100000", rating: 5,
  iban: "IQ12345", bankName: "مصرف الرافدين", paymentTerms: "آجل 30 يوم",
} } });
const supplierId = su[0]?.result?.data?.json?.supplierId ?? su[0]?.result?.data?.json?.id;
check("SUPPLIER created", !!supplierId, "id=" + supplierId);
const suGet = await getCall("/api/trpc/suppliers.get", { supplierId });
const suData = suGet[0]?.result?.data?.json;
check("SUPPLIER 3-phones + cat + rating + bank", !!(suData?.phone && suData?.phone2 && suData?.phone3 && suData?.supplierCategory && suData?.rating && suData?.iban && suData?.bankName),
  "cat=" + suData?.supplierCategory + " rate=" + suData?.rating + " lead=" + suData?.leadTimeDays + " iban=" + suData?.iban + " bank=" + suData?.bankName);

// 3. USER
const us = await call("/api/trpc/users.create?batch=1", { "0": { json: {
  name: "E2E-User-" + TS, email: "e2e" + TS + "@alroya.local", password: "StrongPass123!",
  role: "cashier", phone: "+96477021" + last6, jobTitle: "مسؤول نقطة بيع",
  hiredAt: "2026-01-15", permissionsOverride: { pos: "FULL", reports: "NONE" },
} } });
const userId = us[0]?.result?.data?.json?.userId;
check("USER created", !!userId, "id=" + userId + " err=" + (us[0]?.error?.json?.message ?? ""));
const usGet = await getCall("/api/trpc/users.get", { userId });
const usData = usGet[0]?.result?.data?.json;
check("USER phone + jobTitle + hiredAt + perms-override", !!(usData?.phone && usData?.jobTitle && usData?.hiredAt && usData?.permissionsOverride),
  "phone=" + usData?.phone + " job=" + usData?.jobTitle + " hired=" + usData?.hiredAt + " perms=" + JSON.stringify(usData?.permissionsOverride));

// 4. EXPENSE
const ex = await call("/api/trpc/expenses.create?batch=1", { "0": { json: {
  branchId: 1, expenseDate: "2026-06-09", category: "RENT",
  amount: "250000", paymentMethod: "CASH", description: "إيجار شهري — E2E v3",
  payee: "صاحب العقار", costCenter: "الإدارة والتشغيل",
  isRecurring: true, recurringFrequency: "MONTHLY",
} } });
const expenseId = ex[0]?.result?.data?.json?.expenseId;
check("EXPENSE created", !!expenseId, "id=" + expenseId + " err=" + (ex[0]?.error?.json?.message ?? ""));

// 5. PRODUCT (with name parts + image)
const pr = await call("/api/trpc/catalog.createProduct?batch=1", { "0": { json: {
  productType: "قلم جاف", brand: "Pilot", modelName: "V3-E2E-" + last6,
  description: "E2E", isCustomizable: false,
  variants: [{
    sku: "PV3-" + last6, costPrice: "150", color: "أزرق", size: "0.7mm", minStock: 5, openingStock: 10,
    units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "500" }] }],
  }],
  images: [{ url: "data:image/png;base64," + "A".repeat(2000), isPrimary: true, sortOrder: 0 }],
} } });
const productId = pr[0]?.result?.data?.json?.productId;
check("PRODUCT created", !!productId, "id=" + productId + " err=" + (pr[0]?.error?.json?.message ?? ""));

// 6. WORK ORDER (the big one)
const variantsQuery = await getCall("/api/trpc/catalog.posList", { branchId: 1, tier: "RETAIL", limit: 5 });
const variantsList = variantsQuery[0]?.result?.data?.json || [];
const variantId = variantsList[0]?.variantId;
const productUnitId = variantsList[0]?.productUnitId;
const wo = await call("/api/trpc/workOrders.create?batch=1", { "0": { json: {
  branchId: 1, customerId, baseVariantId: variantId,
  title: "E2E WorkOrder #" + TS, customizationText: "تخصيص اختباري v3 — اسم الشركة الرفيع",
  quantity: 2, salePrice: "150000", laborCost: "20000", dueDate: "2026-06-20",
  receptionChannel: "WHATSAPP", channelHandle: "+9647701234567",
  priority: "URGENT", deposit: "50000",
  paymentMethod: "CARD", paymentReference: "AUTH-482910",
  paymentReceiptUrl: "data:image/png;base64," + "C".repeat(3000),
  hasDelivery: true, deliveryAddress: "بغداد كرادة شارع 52", deliveryCost: "15000",
  items: [{ variantId, productUnitId, quantity: "2", baseQuantity: 2, unitPrice: "25000", total: "50000", discountAmount: "0" }],
  designImages: [{ url: "data:image/png;base64," + "B".repeat(1500), caption: "لوغو", sortOrder: 0 }],
} } });
const workOrderId = wo[0]?.result?.data?.json?.workOrderId;
check("WORKORDER created", !!workOrderId, "id=" + workOrderId + " err=" + (wo[0]?.error?.json?.message ?? ""));

// Verify in DB
const conn = await mysql.createConnection(DB_URL);
const [woRow] = await conn.query(
  "SELECT receptionChannel, channelHandle, woPriority, woPaymentMethod, paymentReference, hasDelivery, deliveryCost, deposit, LENGTH(paymentReceiptUrl) AS receiptLen FROM workOrders WHERE id=?",
  [workOrderId]
);
const w = woRow[0] || {};
check("WO columns v3 (channel/priority/pay/delivery)",
  w.receptionChannel === "WHATSAPP" && w.woPriority === "URGENT" && w.woPaymentMethod === "CARD" && w.paymentReference === "AUTH-482910" && w.hasDelivery === 1 && Number(w.receiptLen) > 1000,
  "ch=" + w.receptionChannel + " pri=" + w.woPriority + " pay=" + w.woPaymentMethod + " ref=" + w.paymentReference + " del=" + w.hasDelivery + " receiptLen=" + w.receiptLen);

const [woItems] = await conn.query("SELECT COUNT(*) AS cnt, MAX(unitPrice) AS p FROM workOrderItems WHERE workOrderId=?", [workOrderId]);
check("WO items in workOrderItems table", woItems[0].cnt >= 1, "count=" + woItems[0].cnt + " unitPrice=" + woItems[0].p);
const [woImgs] = await conn.query("SELECT COUNT(*) AS cnt, MAX(LENGTH(url)) AS maxL FROM workOrderImages WHERE workOrderId=?", [workOrderId]);
check("WO design images in workOrderImages table (TEXT)", woImgs[0].cnt >= 1 && woImgs[0].maxL > 1000, "count=" + woImgs[0].cnt + " maxLen=" + woImgs[0].maxL);
const [prImgs] = await conn.query("SELECT COUNT(*) AS cnt, MAX(LENGTH(url)) AS maxL FROM productImages WHERE productId=?", [productId]);
check("PRODUCT images TEXT column", prImgs[0].cnt >= 1 && prImgs[0].maxL > 1000, "count=" + prImgs[0].cnt + " maxLen=" + prImgs[0].maxL);
const [productRow] = await conn.query("SELECT productType, brand, modelName FROM products WHERE id=?", [productId]);
check("PRODUCT name parts saved", productRow[0]?.productType === "قلم جاف" && productRow[0]?.brand === "Pilot",
  "type=" + productRow[0]?.productType + " brand=" + productRow[0]?.brand + " model=" + productRow[0]?.modelName);
const [expenseRow] = await conn.query("SELECT payee, costCenter, isRecurring, recurringFrequency FROM expenses WHERE id=?", [expenseId]);
check("EXPENSE payee/costCenter/recurring", expenseRow[0]?.payee === "صاحب العقار" && expenseRow[0]?.costCenter === "الإدارة والتشغيل" && expenseRow[0]?.isRecurring === 1 && expenseRow[0]?.recurringFrequency === "MONTHLY",
  "payee=" + expenseRow[0]?.payee + " cc=" + expenseRow[0]?.costCenter + " rec=" + expenseRow[0]?.isRecurring + " freq=" + expenseRow[0]?.recurringFrequency);

await conn.end();

const passed = report.filter(r => r.ok).length;
const failed = report.filter(r => !r.ok).length;
console.log("\n────────────────");
console.log("PASS: " + passed + " / " + report.length + " (failed: " + failed + ")");
process.exit(failed === 0 ? 0 : 1);
