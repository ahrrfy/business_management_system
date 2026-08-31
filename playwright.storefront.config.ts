import { defineConfig } from "@playwright/test";

const baseURL = process.env.STOREFRONT_E2E_BASE_URL?.trim() || "https://alarabiya.online";
const target = new URL(baseURL);
if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
  throw new Error("STOREFRONT_E2E_BASE_URL_INVALID");
}

export default defineConfig({
  testDir: "./tests/e2e/storefront",
  outputDir: "./output/playwright/storefront",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: target.origin,
    locale: "ar-IQ",
    timezoneId: "Asia/Baghdad",
    colorScheme: "light",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    { name: "mobile-320", use: { browserName: "chromium", viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true } },
    { name: "mobile-360", use: { browserName: "chromium", viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true } },
    { name: "mobile-390", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "desktop-1440", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
});
