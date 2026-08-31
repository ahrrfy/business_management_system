import { expect, test, type Page } from "@playwright/test";

const createOrderMarker = "storefront.createOrder";

async function blockOrderCreation(page: Page): Promise<() => number> {
  let attempts = 0;
  await page.route("**/api/trpc/**", async (route) => {
    if (route.request().url().includes(createOrderMarker)) {
      attempts += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return () => attempts;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }))).toMatchObject({ viewport: page.viewportSize()!.width, content: page.viewportSize()!.width });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("arabia_store_consent_v1", "declined");
  });
});

test("home, search and product details remain usable without writes", async ({ page }) => {
  const orderAttempts = await blockOrderCreation(page);
  await page.goto("/store", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveTitle(/مكتبة العربية/);
  await expect(page.getByRole("heading", { level: 1, name: "مكتبة العربية للتسوق والتوصيل في العراق" })).toBeAttached();
  const productLink = page.locator('article.store-product-card button[aria-label^="فتح تفاصيل "]').first();
  await expect(productLink).toBeVisible();
  const productName = (await productLink.getAttribute("aria-label"))!.replace("فتح تفاصيل ", "");

  const search = page.getByRole("searchbox", { name: "البحث في منتجات مكتبة العربية" });
  await search.fill(productName);
  await expect(productLink).toBeVisible();
  await productLink.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(productName);
  await page.getByRole("dialog").getByRole("button", { name: "رجوع" }).click();

  await expectNoHorizontalOverflow(page);
  expect(orderAttempts()).toBe(0);
});

test("cart and checkout validation never create an order", async ({ page }) => {
  const orderAttempts = await blockOrderCreation(page);
  await page.goto("/store", { waitUntil: "domcontentloaded" });

  const directAdd = page.locator("article.store-product-card button", { hasText: /^أضف إلى السلة$/ }).first();
  await expect(directAdd).toBeVisible();
  await expect(directAdd).toBeEnabled();
  await directAdd.click();
  await page.getByRole("button", { name: "السلة", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "سلة المشتريات" })).toBeVisible();

  const checkout = page.getByRole("button", { name: "متابعة إلى الدفع عند الاستلام" });
  await expect(checkout).toBeEnabled();
  await checkout.click();
  const checkoutDialog = page.getByRole("dialog", { name: "إتمام الطلب" });
  await expect(checkoutDialog).toBeVisible();
  await checkoutDialog.getByRole("button", { name: "تأكيد الطلب — الدفع عند الاستلام" }).click();

  await expect(checkoutDialog.getByRole("alert")).toContainText("اكتب الاسم الكامل لاستلام الطلب");
  await expect(checkoutDialog.locator("#storefront-checkout-name")).toBeFocused();
  await expectNoHorizontalOverflow(page);
  expect(orderAttempts()).toBe(0);
});

test("forged URL and local storage cannot manufacture an order confirmation", async ({ page }) => {
  const orderAttempts = await blockOrderCreation(page);
  await page.addInitScript(() => {
    const forged = {
      orderNumber: "FORGED-ORDER-999",
      total: "1.00",
      reservationExpiresAt: "2099-01-01T00:00:00.000Z",
    };
    localStorage.setItem("alroya-store-confirmation-v1", JSON.stringify(forged));
    localStorage.setItem("alroya-store-checkout-attempt-v1", JSON.stringify({
      clientRequestId: "sf-forged-request",
      fingerprint: "forged",
      expectedGrandTotal: "1.00",
      createdAt: Date.now(),
    }));
  });
  await page.goto("/store?order=FORGED-ORDER-999&token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&orderNumber=FORGED-ORDER-999&total=1.00&confirmed=true", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByRole("heading", { level: 1, name: "مكتبة العربية للتسوق والتوصيل في العراق" })).toBeAttached();
  await expect(page.getByRole("dialog", { name: "تمّ استلام طلبك" })).toHaveCount(0);
  await expect(page.getByText("FORGED-ORDER-999", { exact: true })).toHaveCount(0);
  expect(orderAttempts()).toBe(0);
});
