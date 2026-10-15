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

for (const includeHero of [true, false]) {
  test(`marketing creatives stay inside the RTL content area (hero=${includeHero})`, async ({ page }) => {
    const image = (width: number, height: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><rect x="${width - 160}" y="40" width="120" height="${height - 80}" fill="#253550"/></svg>`)}`;
    const banners = [
      ...(includeHero ? [{ id: 90000001, title: "Layout fixture hero", placement: "HERO", imageUrl: image(1600, 800), mobileImageUrl: image(1200, 600), renderMode: "PRESERVE_FULL" }] : []),
      { id: 90000002, title: "Layout fixture inline", placement: "INLINE", imageUrl: image(1500, 500), mobileImageUrl: image(1200, 400), renderMode: "PRESERVE_FULL" },
    ];
    await page.route("**/api/trpc/**", async (route) => {
      const request = route.request();
      const procedures = new URL(request.url()).pathname.split("/").at(-1)!.split(",");
      if (procedures.some((name) => /^storefront\.(track|create|subscribe|unsubscribe|submit)/.test(name))) {
        await route.abort("blockedbyclient");
        return;
      }
      const index = procedures.indexOf("storefront.banners");
      if (index < 0) { await route.continue(); return; }
      const response = await route.fetch();
      const body = await response.json();
      const result = { result: { data: { json: banners } } };
      if (Array.isArray(body)) body[index] = result;
      await route.fulfill({ response, json: Array.isArray(body) ? body : result });
    });
    await page.goto("/store", { waitUntil: "domcontentloaded" });
    const carousel = page.getByRole("region", { name: includeHero ? "العروض الرئيسية" : "العروض الترويجية بين المنتجات" });
    await expect(carousel).toBeVisible();
    const hero = carousel.getByRole("img", { name: includeHero ? "Layout fixture hero" : "Layout fixture inline", exact: true });
    await expect(hero).toBeVisible();
    const layout = await hero.evaluate((element) => {
      const im = element as HTMLImageElement;
      const r = im.getBoundingClientRect(), main = document.querySelector("#store-main")!.getBoundingClientRect();
      return { left: r.left, right: r.right, ratio: r.width / r.height, mainLeft: main.left, mainRight: main.right, fit: getComputedStyle(im).objectFit, background: getComputedStyle(im.parentElement!).backgroundColor };
    });
    expect(layout.left).toBeGreaterThanOrEqual(layout.mainLeft);
    expect(layout.right).toBeLessThanOrEqual(layout.mainRight);
    expect(layout.ratio).toBeCloseTo(includeHero ? 2 : 3, 2);
    expect(layout.fit).toBe("contain");
    expect(layout.background).toBe("rgb(255, 255, 255)");
    await expectNoHorizontalOverflow(page);
  });
}

test("fallback marketing creative keeps its managed placement for metrics", async ({ page }) => {
  const metrics: Array<{ bannerId: number; placement: string; event: string }> = [];
  const imageUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800"><rect width="100%" height="100%" fill="white"/></svg>')}`;
  const banners = [
    { id: 90000011, title: "Metrics fixture primary", placement: "HERO", imageUrl, renderMode: "PRESERVE_FULL" },
    { id: 90000012, title: "Metrics fixture fallback", placement: "HERO", imageUrl, renderMode: "PRESERVE_FULL", ctaUrl: "#store-main" },
  ];
  await page.route("**/api/trpc/**", async (route) => {
    const request = route.request();
    const procedures = new URL(request.url()).pathname.split("/").at(-1)!.split(",");
    const metricIndex = procedures.indexOf("storefront.trackBanner");
    if (metricIndex >= 0) {
      const body = request.postDataJSON();
      metrics.push((body[metricIndex] ?? body).json);
      await route.fulfill({ json: procedures.length > 1 || new URL(request.url()).searchParams.has("batch")
        ? procedures.map(() => ({ result: { data: { json: { ok: true } } } }))
        : { result: { data: { json: { ok: true } } } } });
      return;
    }
    if (procedures.some((name) => /^storefront\.(track|create|subscribe|unsubscribe|submit)/.test(name))) {
      await route.abort("blockedbyclient");
      return;
    }
    if (!procedures.some((name) => name === "storefront.banners" || name === "storefront.offers")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const results = Array.isArray(body) ? body : [body];
    procedures.forEach((name, index) => {
      if (name === "storefront.banners" || name === "storefront.offers") {
        results[index] = { result: { data: { json: name === "storefront.banners" ? banners : [] } } };
      }
    });
    await route.fulfill({ response, json: Array.isArray(body) ? results : results[0] });
  });
  await page.goto("/store", { waitUntil: "domcontentloaded" });
  const fallback = page.getByRole("img", { name: "Metrics fixture fallback", exact: true }).last();
  await fallback.scrollIntoViewIfNeeded();
  expect(await fallback.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width / rect.height;
  })).toBeCloseTo(3, 2);
  await expect.poll(() => metrics).toContainEqual({ bannerId: 90000012, placement: "HERO", event: "IMPRESSION" });
  await fallback.click();
  await expect.poll(() => metrics).toContainEqual({ bannerId: 90000012, placement: "HERO", event: "CLICK" });
});
