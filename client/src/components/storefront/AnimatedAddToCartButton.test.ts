import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./AnimatedAddToCartButton.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("./animated-add-to-cart.css", import.meta.url), "utf8");
const storefrontSource = readFileSync(new URL("../../pages/Storefront.tsx", import.meta.url), "utf8");
const curatedRowsSource = readFileSync(new URL("./StorefrontCuratedRows.tsx", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("./StorefrontProductCard.tsx", import.meta.url), "utf8");

describe("AnimatedAddToCartButton Component Contract", () => {
  it("includes dual-bag architecture (ink outside, white inside clipped pill)", () => {
    expect(source).toContain('className="bag bag--out"');
    expect(source).toContain('className="bag bag--in"');
    expect(source).toContain('className="pill"');
    expect(source).toContain('className="cart"');
    expect(source).toContain('className="pill__label"');
  });

  it("handles state transitions and reduced motion preference", () => {
    expect(source).toContain('prefers-reduced-motion: reduce');
    expect(source).toContain('data-state={state}');
    expect(source).toContain('handleCartAnimationEnd');
    expect(source).toContain('cart-run');
  });

  it("defines 60-frame synchronization keyframes and physics in CSS", () => {
    expect(cssSource).toContain("@keyframes cart-run");
    expect(cssSource).toContain("@keyframes cart-physics");
    expect(cssSource).toContain("@keyframes bag-drop-out");
    expect(cssSource).toContain("@keyframes bag-ride-in");
    expect(cssSource).toContain("@keyframes label-hide-show");
    expect(cssSource).toContain("--from-left");
    expect(cssSource).toContain("--to-centre");
    expect(cssSource).toContain("--to-exit");
    expect(cssSource).toContain("--bag-drop-y");
    expect(cssSource).toContain(".btn--xs");
    expect(cssSource).toContain(".btn--sm");
  });

  it("verifies RelatedProductStrip in Storefront fixes pointer capture bug and integrates size xs", () => {
    // Pointer down must not capture pointer immediately or intercept button clicks
    expect(storefrontSource).toContain('(event.target as HTMLElement).closest("button, a, select, input, label")');
    expect(storefrontSource).toContain("event.stopPropagation()");
    expect(storefrontSource).toContain("AnimatedAddToCartButton");
    expect(storefrontSource).toContain('size="xs"');
  });

  it("verifies StorefrontProductCard integrates AnimatedAddToCartButton size sm", () => {
    expect(cardSource).toContain('import { AnimatedAddToCartButton } from "./AnimatedAddToCartButton";');
    expect(cardSource).toContain('<AnimatedAddToCartButton');
    expect(cardSource).toContain('size="sm"');
  });

  it("verifies StorefrontCuratedRows integrates AnimatedAddToCartButton", () => {
    expect(curatedRowsSource).toContain('import { AnimatedAddToCartButton } from "./AnimatedAddToCartButton";');
    expect(curatedRowsSource).toContain('<AnimatedAddToCartButton');
    expect(curatedRowsSource).toContain('size="sm"');
  });
});
