import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "app/sign-in.tsx"), "utf8");
const tabsSource = readFileSync(
  resolve(process.cwd(), "app/(tabs)/_layout.tsx"),
  "utf8",
);

describe("sign-in visual contract", () => {
  it("keeps the busy call-to-action legible and exposes progress", () => {
    expect(source).toContain("<ActivityIndicator");
    expect(source).toContain("accessibilityState={{ busy, disabled: busy }}");
    expect(source).toContain("aria-busy={busy}");
    expect(source).not.toMatch(
      /\(pressed\s*\|\|\s*busy\)\s*&&\s*styles\.primaryPressed/,
    );
  });

  it("does not communicate the remembered-device selection by color alone", () => {
    expect(source).toContain("aria-checked={remember}");
    expect(source).toMatch(
      /remember\s*\?\s*\(?\s*<Ionicons[^>]+name="checkmark"/s,
    );
  });

  it("reserves enough web preview height for icon and Arabic tab labels", () => {
    expect(tabsSource).toContain(
      'height: Platform.OS === "web" ? 82 : 68 + insets.bottom',
    );
    expect(tabsSource).toMatch(
      /paddingBottom:\s*Platform\.OS === "web" \? 12 : Math\.max\(insets\.bottom, 8\)/,
    );
  });
});
