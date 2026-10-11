import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalIraqiMobile } from "../../lib/phone";

const fake = vi.hoisted(() => ({
  rows: [] as unknown[][],
  selects: 0,
  wheres: [] as unknown[],
}));
vi.mock("../tx", () => ({
  requireDb: () => ({
    select() {
      fake.selects++;
      const rows = fake.rows.shift() ?? [];
      const builder = {
        from: () => builder,
        leftJoin: () => builder,
        innerJoin: () => builder,
        where: (where: unknown) => {
          fake.wheres.push(where);
          return builder;
        },
        orderBy: () => builder,
        limit: () => Promise.resolve(rows),
        then: (resolve: (rows: unknown[]) => unknown) =>
          Promise.resolve(rows).then(resolve),
      };
      return builder;
    },
  }),
}));

import {
  getReceptionDuplicateOrders,
  receptionDuplicatePhoneForms,
  receptionDuplicateSameLineage,
} from "./duplicateOrders";
const actor = { userId: 7, branchId: 2, role: "cashier" };
const phone = "+9647701234567";
const phones = { phone, phone2: null, phone3: null, whatsapp: null };
const draft = (id = 10, extra = {}) => ({
  id,
  number: `DRF-${id}`,
  channel: "WHATSAPP",
  createdAt: new Date("2026-10-10T10:00:00Z"),
  total: "1000.00",
  contact: phone,
  handle: null,
  customerId: null,
  invoiceId: null,
  printInvoiceId: null,
  ...phones,
  ...extra,
});

beforeEach(() => {
  fake.rows = [];
  fake.selects = 0;
  fake.wheres = [];
});

describe("reception duplicate server boundary", () => {
  it("canonicalizes Iraqi ASCII, Arabic, and Persian phone representations", () => {
    for (const raw of [
      "07701234567",
      "+9647701234567",
      "009647701234567",
      "٠٧٧٠١٢٣٤٥٦٧",
      "۰۷۷۰۱۲۳۴۵۶۷",
      "+964 (770) 123-4567",
    ]) {
      expect(canonicalIraqiMobile(raw)).toBe(phone);
      expect(receptionDuplicatePhoneForms(raw)).toContain(phone);
    }
    expect(receptionDuplicatePhoneForms("1234567")).toEqual([]);
  });
  it("rejects cross-branch requests before any database read", async () => {
    await expect(
      getReceptionDuplicateOrders({ branchId: 3, phone }, actor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.selects).toBe(0);
  });
  it("requires a positive explicit branch", async () => {
    await expect(
      getReceptionDuplicateOrders({ branchId: 0, phone }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fake.selects).toBe(0);
  });
  it("branch-scopes referenced IDs, including for administrators", async () => {
    fake.rows = [[]];
    await expect(
      getReceptionDuplicateOrders(
        { branchId: 2, reference: { kind: "ONLINE", id: 99 }, phone },
        { ...actor, role: "admin" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.selects).toBe(1);
    expect(fake.wheres).toHaveLength(1);
  });
  it("does not let a supplied phone replace the stored reference identity", async () => {
    fake.rows = [[draft(10, { contact: null, ...phones, phone: null })]];
    expect(
      await getReceptionDuplicateOrders(
        {
          branchId: 2,
          reference: { kind: "DRAFT", id: 10 },
          phone,
          lines: [{ variantId: 1, quantity: "1" }],
        },
        actor,
      ),
    ).toEqual({ checked: false, matches: [], truncated: false });
    expect(fake.selects).toBe(1);
  });
  it("rejects a foreign or missing excluded draft rather than trusting its id", async () => {
    fake.rows = [[]];
    await expect(
      getReceptionDuplicateOrders(
        {
          branchId: 2,
          excludeDraftId: 99,
          phone,
          lines: [{ variantId: 1, quantity: "1" }],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("returns unknown for a missing or malformed phone", async () => {
    expect(
      await getReceptionDuplicateOrders({ branchId: 2, phone: "123" }, actor),
    ).toEqual({ checked: false, matches: [], truncated: false });
    expect(fake.selects).toBe(0);
  });
  it("does not claim a comparison when the incoming basket is empty", async () => {
    expect(
      await getReceptionDuplicateOrders({ branchId: 2, phone }, actor),
    ).toEqual({ checked: false, matches: [], truncated: false });
    expect(fake.selects).toBe(0);
  });
  it("compares phone-selected candidates with batched lines and exposes the actual invoice", async () => {
    fake.rows = [
      [{ id: 5, ...phones }],
      [draft()],
      [
        {
          id: 20,
          number: "ORD-20",
          createdAt: new Date("2026-10-10T09:00:00Z"),
          total: "1000.00",
          status: "PROCESSING",
          customerId: 5,
          invoiceId: 44,
          ...phones,
        },
      ],
      [],
      [
        {
          parentId: 10,
          lineKind: "GOODS",
          variantId: 1,
          productUnitId: 100,
          quantity: "1",
          title: "دفتر",
          customizationText: null,
          printSpec: null,
        },
      ],
      [
        {
          parentId: 20,
          variantId: 1,
          productUnitId: 101,
          quantity: "12",
          baseQuantity: 12,
          customizationSnapshot: null,
        },
      ],
      [
        { id: 100, variantId: 1, factor: "12" },
        { id: 101, variantId: 1, factor: "1" },
      ],
      [{ id: 1, isService: false }],
      [{ id: 44, number: "INV-44", total: "1000.00", status: "PENDING" }],
    ];
    const result = await getReceptionDuplicateOrders(
      {
        branchId: 2,
        phone: "٠٧٧٠١٢٣٤٥٦٧",
        lines: [{ variantId: 1, productUnitId: 100, quantity: "1" }],
        total: "1000",
      },
      actor,
    );
    expect(result.checked).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.find((m) => m.kind === "ONLINE")).toMatchObject({
      matchLevel: "EXACT",
      quantityMatch: true,
      invoice: {
        id: 44,
        number: "INV-44",
        total: "1000.00",
        status: "PENDING",
      },
    });
    expect(fake.selects).toBe(9);
    expect(fake.rows).toHaveLength(0);
  });
  it("reports candidate truncation even when no reliable content match was found", async () => {
    fake.rows = [
      [],
      Array.from({ length: 61 }, (_, i) => draft(i + 1)),
      [],
      [],
      [],
    ];
    const result = await getReceptionDuplicateOrders(
      { branchId: 2, phone, lines: [{ variantId: 1, quantity: "1" }] },
      actor,
    );
    expect(result).toEqual({ checked: true, matches: [], truncated: true });
  });
});

describe("source lineage", () => {
  const header = (extra = {}) => ({
    kind: "DRAFT" as const,
    id: 1,
    number: "DRF",
    channel: "WHATSAPP" as const,
    createdAt: new Date(),
    statusLabel: "طلب محفوظ",
    total: "1000",
    phones: [phone],
    customerId: null,
    draftId: 1,
    invoiceId: null,
    linkedInvoiceIds: [] as number[],
    ...extra,
  });
  it("excludes a draft and the work orders generated from it", () => {
    expect(
      receptionDuplicateSameLineage(
        header(),
        header({ kind: "WORK_ORDER", id: 10 }),
      ),
    ).toBe(true);
    expect(
      receptionDuplicateSameLineage(
        header({ kind: "WORK_ORDER", id: 10 }),
        header({ kind: "WORK_ORDER", id: 11 }),
      ),
    ).toBe(true);
  });
  it("excludes documents backed by the same invoice without merging independent orders", () => {
    expect(
      receptionDuplicateSameLineage(
        header({ linkedInvoiceIds: [44] }),
        header({
          kind: "ONLINE",
          id: 20,
          draftId: null,
          linkedInvoiceIds: [44],
        }),
      ),
    ).toBe(true);
    expect(
      receptionDuplicateSameLineage(header(), header({ id: 2, draftId: 2 })),
    ).toBe(false);
  });
});
