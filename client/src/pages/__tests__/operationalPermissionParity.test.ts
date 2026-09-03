import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPLICATION_MODULES } from "@/lib/moduleRegistry";
import { canSeeGate } from "@/lib/navVisibility";
import { moduleAccessAllowed } from "@shared/permissions";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

const section = (source: string, start: string, end: string) => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing end marker: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
};

describe("operational UI permission parity", () => {
  it("keeps production tabs on inventory FULL with the manager role fallback", () => {
    const source = readPage("PrintHub.tsx");

    for (const tab of ["production", "recipes"]) {
      const declaration = source
        .split(/\r?\n/)
        .find((line) => line.includes(`value: "${tab}"`));

      expect(declaration, `${tab} tab declaration`).toContain(
        'gate: { roles: ["manager"], module: "inventory", level: "FULL" }',
      );
    }

    expect(
      moduleAccessAllowed("manager", null, "inventory", "FULL", ["manager"]),
    ).toBe(true);
    expect(
      moduleAccessAllowed(
        "accountant",
        { inventory: "FULL" },
        "inventory",
        "FULL",
        ["manager"],
      ),
    ).toBe(true);
    expect(
      moduleAccessAllowed(
        "manager",
        { inventory: "READ" },
        "inventory",
        "FULL",
        ["manager"],
      ),
    ).toBe(false);
    expect(
      moduleAccessAllowed("accountant", null, "inventory", "FULL", ["manager"]),
    ).toBe(false);
  });

  it("keeps the print hub discoverable through workorders or inventory FULL", () => {
    const workOrders = APPLICATION_MODULES.find(
      (module) => module.id === "workOrders",
    );

    expect(workOrders?.anyOf).toEqual([
      { module: "workorders" },
      { roles: ["manager"], module: "inventory", level: "FULL" },
    ]);
    expect(canSeeGate(workOrders, "print_operator", null)).toBe(true);
    expect(
      canSeeGate(workOrders, "accountant", {
        workorders: "NONE",
        inventory: "FULL",
      }),
    ).toBe(true);
    expect(
      canSeeGate(workOrders, "accountant", {
        workorders: "NONE",
        inventory: "READ",
      }),
    ).toBe(false);
  });

  it("keeps dispatch, manual proof, remittance, and row actions on store FULL", () => {
    const source = readPage("DeliveryHub.tsx");
    const dispatchAuthority = section(
      source,
      "const canDispatch",
      "const [target",
    );
    const dispatchActions = section(source, "<RowActions", "<DispatchDialog");
    const manualProofAuthority = section(
      source,
      "const isManager",
      "// ── Mutations",
    );
    const manualProofAction = section(
      source,
      "{isManager && (r.viewKey",
      "{phone &&",
    );
    const remitAuthority = section(source, "const canRemit", "const canReturn");
    const remitAction = section(source, "{canRemit && (", "</Button>");

    expect(dispatchAuthority).toMatch(
      /moduleAccessAllowed\([\s\S]*?"store",\s*"FULL",\s*\["cashier", "manager"\]/,
    );
    expect(dispatchActions).toContain("hidden: !canDispatch");
    expect(dispatchActions).toContain(
      'gate: { roles: ["cashier", "manager"], module: "store", level: "FULL" }',
    );
    expect(manualProofAuthority).toMatch(
      /moduleAccessAllowed\([\s\S]*?"store",\s*"FULL",\s*\["manager"\]/,
    );
    expect(manualProofAction).toContain("setManualProofTarget(r)");
    expect(remitAuthority).toMatch(
      /moduleAccessAllowed\([\s\S]*?"store",\s*"FULL",\s*\["cashier", "manager"\]/,
    );
    expect(remitAction).toMatch(/title=\{\s*listStillLoading\s*\?/);

    expect(
      moduleAccessAllowed("cashier", null, "store", "FULL", [
        "cashier",
        "manager",
      ]),
    ).toBe(true);
    expect(
      moduleAccessAllowed("cashier", { store: "NONE" }, "store", "FULL", [
        "cashier",
        "manager",
      ]),
    ).toBe(false);
    expect(
      moduleAccessAllowed("manager", null, "store", "FULL", ["manager"]),
    ).toBe(true);
    expect(
      moduleAccessAllowed("cashier", null, "store", "FULL", ["manager"]),
    ).toBe(false);
  });

  it("keeps production cancellation on inventory FULL authority", () => {
    const source = readPage("ProductionDetail.tsx");
    const authority = section(source, "const isManager", "const utils");
    const action = section(
      source,
      '{isManager && doc.status !== "CANCELLED"',
      "</div>",
    );

    expect(authority).toMatch(
      /moduleAccessAllowed\([\s\S]*?"inventory",\s*"FULL",\s*\["manager"\]/,
    );
    expect(action).toContain("onClick={onCancel}");
    expect(action).toContain("إلغاء المستند (يعكس المخزون)");
  });
});
