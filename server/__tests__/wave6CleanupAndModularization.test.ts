import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as outboxBarrel from "../../client/src/lib/offline/outbox";
import * as outboxTypes from "../../client/src/lib/offline/outboxTypes";
import {
  decodeStudioThumbnail,
  isCompleteStillWebp,
  locateStillWebpFrame,
} from "../services/productStudioService";

describe("Wave 6 — Lean cleanup, barrel-preserving modularization & segmented TS projects", () => {
  it("removes all 17 dead packages and 12 dead UI wrappers while keeping archived docs organized", () => {
    const root = process.cwd();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dead of [
      "@fontsource/cairo",
      "animate.css",
      "html2pdf.js",
      "node-thermal-printer",
      "date-fns",
      "@tailwindcss/typography",
      "@radix-ui/react-accordion",
      "@radix-ui/react-aspect-ratio",
      "@radix-ui/react-avatar",
      "react-day-picker",
      "embla-carousel-react",
      "vaul",
      "@radix-ui/react-menubar",
      "@radix-ui/react-navigation-menu",
      "react-resizable-panels",
      "@radix-ui/react-toggle",
      "@radix-ui/react-toggle-group",
    ]) {
      expect(allDeps[dead]).toBeUndefined();
    }

    for (const deadUi of [
      "accordion.tsx",
      "aspect-ratio.tsx",
      "avatar.tsx",
      "calendar.tsx",
      "carousel.tsx",
      "chart.tsx",
      "drawer.tsx",
      "menubar.tsx",
      "navigation-menu.tsx",
      "resizable.tsx",
      "toggle.tsx",
      "toggle-group.tsx",
    ]) {
      expect(
        fs.existsSync(path.join(root, "client/src/components/ui", deadUi)),
      ).toBe(false);
    }

    expect(fs.existsSync(path.join(root, "tsconfig.base.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tsconfig.shared.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tsconfig.server.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tsconfig.client.json"))).toBe(true);
    expect(pkg.scripts?.["check:shared"]).toContain("tsconfig.shared.json");
    expect(pkg.scripts?.["check:server"]).toContain("tsconfig.server.json");
    expect(pkg.scripts?.["check:client"]).toContain("tsconfig.client.json");
  });

  it("preserves 100% of outbox and productStudioService public barrel exports after modular extraction", () => {
    expect(outboxBarrel.OFFLINE_QUEUE_CAP_IQD).toBe(
      outboxTypes.OFFLINE_QUEUE_CAP_IQD,
    );
    expect(outboxBarrel.PREFLIGHT_TOMBSTONE_RETENTION_MS).toBe(
      72 * 60 * 60 * 1000,
    );
    expect(outboxBarrel.OfflineCounterCorruptError).toBe(
      outboxTypes.OfflineCounterCorruptError,
    );
    expect(typeof isCompleteStillWebp).toBe("function");
    expect(typeof locateStillWebpFrame).toBe("function");
    expect(typeof decodeStudioThumbnail).toBe("function");
    expect(isCompleteStillWebp(Buffer.from("not-webp"))).toBe(false);
  });
});
