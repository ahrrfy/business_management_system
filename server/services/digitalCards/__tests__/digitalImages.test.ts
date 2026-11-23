import express from "express";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../drizzle/schema";
import { applyBodyParsers } from "../../../middleware/bodyParsers";
import type { DB, Tx } from "../../../db";
import {
  digitalImageHash,
  digitalProviderLogoUrl,
  normalizeAndValidateImageDataUrl,
  resolveDigitalOfferingImages,
} from "../imageHelpers";
import {
  applyLogoToOfferings,
  getProvider,
  listProviders,
  updateProvider,
} from "../providerService";
import {
  getOffering,
  listOfferings,
  updateOffering,
} from "../offeringService";
import { confirmCard, listCards } from "../posCards";
import {
  resolveImageFormSubmission,
  toExistingImageItems,
} from "../../../../client/src/components/digitalCards/DigitalCardImage";

// 1x1 PNG صالحة (ترويسة IHDR حقيقية + بايتات صحيحة)
const VALID_PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const VALID_PNG = `data:image/png;base64,${VALID_PNG_BYTES.toString("base64")}`;

// 2x2 PNG صالحة لإثبات تغيّر البصمة عند اختلاف الصورة
const VALID_PNG_2_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000e49444154789c636060606000000008000127b104c40000000049454e44ae426082",
  "hex",
);
const VALID_PNG_2 = `data:image/png;base64,${VALID_PNG_2_BYTES.toString("base64")}`;

const VALID_JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64")}`;

const actor = { userId: 1, branchId: 1 };

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function makeSelectChain<T>(rows: T[]) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: (v: T[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

describe("digital cards image helpers & validation", () => {
  it("normalizes empty strings and whitespace to null before validation/storage", () => {
    expect(normalizeAndValidateImageDataUrl(undefined)).toBeUndefined();
    expect(normalizeAndValidateImageDataUrl(null)).toBeNull();
    expect(normalizeAndValidateImageDataUrl("")).toBeNull();
    expect(normalizeAndValidateImageDataUrl("   \n\t  ")).toBeNull();
    expect(normalizeAndValidateImageDataUrl(`  ${VALID_PNG}  `)).toBe(VALID_PNG);
  });

  it("validates image data URLs strictly via assertValidImageDataUrl", () => {
    expect(() =>
      normalizeAndValidateImageDataUrl("data:text/html;base64,PHNjcmlwdD4="),
    ).toThrow(/صيغة غير صالحة/);

    expect(() =>
      normalizeAndValidateImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="),
    ).toThrow(/صيغة غير صالحة/);

    // PNG MIME مع بايتات JPEG مزيّفة
    const fakePng = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString("base64")}`;
    expect(() => normalizeAndValidateImageDataUrl(fakePng)).toThrow(/لا يطابق صيغتها/);

    // تتجاوز سقف 2MB
    const oversized = `data:image/png;base64,${Buffer.concat([VALID_PNG_BYTES, Buffer.alloc(2_100_000)]).toString("base64")}`;
    expect(() => normalizeAndValidateImageDataUrl(oversized)).toThrow(/أكبر من المسموح/);
  });

  it("generates lightweight /api/img/digital-* URLs with sha256 prefix & inheritance", () => {
    expect(digitalProviderLogoUrl(7, null)).toBeNull();
    expect(digitalProviderLogoUrl(7, "")).toBeNull();
    expect(digitalProviderLogoUrl(7, "   ")).toBeNull();

    const pUrl = digitalProviderLogoUrl(7, ` ${VALID_PNG} `);
    expect(pUrl).toBe(`/api/img/digital-provider/7?v=${digitalImageHash(VALID_PNG)}`);
    expect(pUrl).toMatch(/^\/api\/img\/digital-provider\/7\?v=[0-9a-f]{16}$/);

    // لا صورة للمزوّد ولا للعرض
    expect(resolveDigitalOfferingImages(12, null, "")).toEqual({
      ownImageUrl: null,
      effectiveImageUrl: null,
      hasCustomImage: false,
      inheritsProviderLogo: false,
    });

    // وراثة من شعار المزوّد عندما تكون صورة العرض فارغة أو null
    const inherited = resolveDigitalOfferingImages(12, "", VALID_PNG);
    expect(inherited).toEqual({
      ownImageUrl: null,
      effectiveImageUrl: `/api/img/digital-offering/12?v=${digitalImageHash(VALID_PNG, "inherited")}`,
      hasCustomImage: false,
      inheritsProviderLogo: true,
    });

    // صورة مخصّصة للعرض تتغلّب على شعار المزوّد
    const custom = resolveDigitalOfferingImages(12, VALID_PNG_2, VALID_PNG);
    expect(custom).toEqual({
      ownImageUrl: `/api/img/digital-offering/12?v=${digitalImageHash(VALID_PNG_2, "custom")}`,
      effectiveImageUrl: `/api/img/digital-offering/12?v=${digitalImageHash(VALID_PNG_2, "custom")}`,
      hasCustomImage: true,
      inheritsProviderLogo: false,
    });

    // تمييز :custom عن :inherited حتى لو تطابقت البايتات
    const sameBytesCustom = resolveDigitalOfferingImages(12, VALID_PNG, VALID_PNG);
    expect(sameBytesCustom.effectiveImageUrl).not.toBe(inherited.effectiveImageUrl);
  });
});

describe("providerService & offeringService lightweight image contracts", () => {
  it("listProviders and getProvider return lightweight logoUrl + hasLogo without raw base64", async () => {
    const mockRows = [
      {
        id: 10,
        supplierId: 100,
        supplierName: "آسياسيل",
        supplierPhone: "0770",
        providerType: "TELECOM",
        settlementMode: "PREPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "REQUIRED",
        settlementCycle: "ON_DEMAND",
        lowBalanceThreshold: "0.00",
        isActive: true,
        logoUrl: VALID_PNG,
        notes: null,
        createdBy: 1,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: 11,
        supplierId: 101,
        supplierName: "زين",
        supplierPhone: null,
        providerType: "TELECOM",
        settlementMode: "POSTPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "MONTHLY",
        lowBalanceThreshold: "0.00",
        isActive: true,
        logoUrl: "   ",
        notes: null,
        createdBy: 1,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ];
    const db = {
      select: () => makeSelectChain(mockRows),
    } as unknown as DB;

    const listed = await listProviders(db);
    expect(listed[0].hasLogo).toBe(true);
    expect(listed[0].logoUrl).toBe(`/api/img/digital-provider/10?v=${digitalImageHash(VALID_PNG)}`);
    expect(JSON.stringify(listed)).not.toContain("data:image/");
    expect(listed[1].hasLogo).toBe(false);
    expect(listed[1].logoUrl).toBeNull();

    const single = await getProvider({ select: () => makeSelectChain([mockRows[0]]) } as unknown as DB, 10);
    expect(single.hasLogo).toBe(true);
    expect(single.logoUrl).toBe(`/api/img/digital-provider/10?v=${digitalImageHash(VALID_PNG)}`);
  });

  it("updateProvider leaves logoUrl untouched on undefined, clears on empty string/null, and redacts base64 in audit", async () => {
    const sets: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];

    const makeTx = () =>
      ({
        select: () =>
          makeSelectChain([
            { id: 5, settlementMode: "PREPAID", logoUrl: VALID_PNG },
          ]),
        update: () => ({
          set: (payload: Record<string, unknown>) => {
            sets.push(payload);
            return { where: async () => [{ affectedRows: 1 }] };
          },
        }),
        insert: () => ({
          values: async (val: Record<string, unknown>) => {
            audits.push(val);
            return [{ insertId: 1 }];
          },
        }),
      }) as unknown as Tx;

    // undefined -> لا يمسّ logoUrl ولا يكتب تحديثاً إذا لا يوجد حقول أخرى
    await updateProvider(makeTx(), { id: 5, notes: "ملاحظة" }, actor);
    expect(sets[0]).toEqual({ notes: "ملاحظة" });
    expect("logoUrl" in sets[0]).toBe(false);

    // "" -> يُطبَّع إلى null
    await updateProvider(makeTx(), { id: 5, logoUrl: "" }, actor);
    expect(sets[1]).toEqual({ logoUrl: null });

    // data URL صالحة -> يُحفَظ ويُحجَب base64 عن سجل التدقيق
    await updateProvider(makeTx(), { id: 5, logoUrl: VALID_JPEG }, actor);
    expect(sets[2]).toEqual({ logoUrl: VALID_JPEG });
    expect(JSON.stringify(audits[2])).not.toContain("data:image/");
    expect(JSON.stringify(audits[2])).toContain("[REDACTED_IMAGE]");
  });

  it("updateOffering clears imageUrl on null/empty string and preserves on undefined", async () => {
    const sets: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];

    const makeTx = () =>
      ({
        select: () =>
          makeSelectChain([
            {
              id: 20,
              providerId: 5,
              productId: 50,
              variantId: 51,
              productUnitId: 52,
              isActive: false,
              offeringType: "TELECOM_CARD",
              requiresStudentData: false,
              subscriptionDurationDays: null,
            },
          ]),
        update: () => ({
          set: (payload: Record<string, unknown>) => {
            sets.push(payload);
            return { where: async () => [{ affectedRows: 1 }] };
          },
        }),
        insert: () => ({
          values: async (val: Record<string, unknown>) => {
            audits.push(val);
            return [{ insertId: 1 }];
          },
        }),
      }) as unknown as Tx;

    await updateOffering(makeTx(), { id: 20, faceCurrency: "USD" }, actor);
    expect(sets[0]).toEqual({ faceCurrency: "USD" });

    await updateOffering(makeTx(), { id: 20, imageUrl: "" }, actor);
    expect(sets[1]).toEqual({ imageUrl: null });

    await updateOffering(makeTx(), { id: 20, imageUrl: VALID_PNG }, actor);
    expect(sets[2]).toEqual({ imageUrl: VALID_PNG });
    expect(JSON.stringify(audits[2])).not.toContain("data:image/");
  });

  it("listOfferings and getOffering return resolved inheritance URLs without raw base64", async () => {
    const offeringRows = [
      {
        id: 30,
        providerId: 5,
        providerType: "TELECOM",
        settlementMode: "PREPAID",
        supplierName: "آسياسيل",
        productId: 50,
        productName: "كارت 10 آلاف",
        variantId: 51,
        productUnitId: 52,
        offeringType: "TELECOM_CARD",
        requiresStudentData: false,
        subscriptionDurationDays: null,
        faceValue: "10000.00",
        faceCurrency: "IQD",
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "500.00",
        marginPercent: "0.00",
        minimumMargin: "0.00",
        roundingStep: "250.00",
        priceValidityHours: null,
        cardColorToken: null,
        ownImageDataUrl: null,
        providerLogoDataUrl: VALID_PNG,
        isActive: true,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ];
    const branchRows = [
      {
        offeringId: 30,
        branchId: 1,
        branchName: "الرئيسي",
        walletId: 2,
        deviceCode: "DEV-1",
        walletName: "جهاز 1",
        walletIsActive: true,
        isActive: true,
        isFavorite: false,
        displayOrder: 0,
      },
    ];
    let call = 0;
    const db = {
      select: () => {
        call++;
        return makeSelectChain<any>(call === 1 ? offeringRows : branchRows);
      },
    } as unknown as DB;

    const listed = await listOfferings(db, {});
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      ownImageUrl: null,
      effectiveImageUrl: `/api/img/digital-offering/30?v=${digitalImageHash(VALID_PNG, "inherited")}`,
      hasCustomImage: false,
      inheritsProviderLogo: true,
    });
    expect(JSON.stringify(listed)).not.toContain("data:image/");

    let getCall = 0;
    const singleDb = {
      select: () => {
        getCall++;
        return makeSelectChain<any>(getCall === 1 ? offeringRows : branchRows);
      },
    } as unknown as DB;
    const single = await getOffering(singleDb, 30);
    expect(single.inheritsProviderLogo).toBe(true);
    expect(single.ownImageUrl).toBeNull();
    expect(JSON.stringify(single)).not.toContain("data:image/");
  });

  it("applyLogoToOfferings rejects providers without a logo and atomically saves + resets overrides when valid", async () => {
    let offeringsUpdated = false;
    const noLogoTx = {
      select: () => makeSelectChain([{ id: 5, logoUrl: "" }]),
      update: () => {
        offeringsUpdated = true;
        return { set: () => ({ where: async () => [{ affectedRows: 1 }] }) };
      },
    } as unknown as Tx;

    await expect(
      applyLogoToOfferings(noLogoTx, { providerId: 5 }, actor),
    ).rejects.toThrow(/لا يملك شعاراً/);
    expect(offeringsUpdated).toBe(false);

    // تمرير logoUrl جديد فارغ/null يرفض أيضاً قبل أي تعديل
    await expect(
      applyLogoToOfferings(
        {
          select: () => makeSelectChain([{ id: 5, logoUrl: VALID_PNG }]),
          update: () => {
            offeringsUpdated = true;
            return { set: () => ({ where: async () => [{ affectedRows: 1 }] }) };
          },
        } as unknown as Tx,
        { providerId: 5, logoUrl: "" },
        actor,
      ),
    ).rejects.toThrow(/لا يملك شعاراً/);
    expect(offeringsUpdated).toBe(false);

    // تمرير logoUrl جديد يحفظ شعار المزوّد ويصفّر صور العروض في نفس المعاملة
    const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];
    const audits: Record<string, unknown>[] = [];
    const applyTx = {
      select: () => makeSelectChain([{ id: 5, logoUrl: null }]),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          updateCalls.push({ table, set });
          return { where: async () => [{ affectedRows: table === schema.digitalOfferings ? 3 : 1 }] };
        },
      }),
      insert: () => ({
        values: async (val: Record<string, unknown>) => {
          audits.push(val);
          return [{ insertId: 1 }];
        },
      }),
    } as unknown as Tx;

    const result = await applyLogoToOfferings(
      applyTx,
      { providerId: 5, logoUrl: VALID_PNG_2 },
      actor,
    );
    expect(result).toEqual({ updatedCount: 3 });
    expect(updateCalls).toEqual([
      { table: schema.digitalProviders, set: { logoUrl: VALID_PNG_2 } },
      { table: schema.digitalOfferings, set: { imageUrl: null } },
    ]);
    expect(JSON.stringify(audits)).not.toContain("data:image/");
    expect(audits[0].newValue).toMatchObject({
      providerId: 5,
      updatedCount: 3,
      logoUpdated: true,
    });
  });
});

describe("posCards lightweight image & zero-duplication contract", () => {
  it("returns one row per offering without productImages join and serves lightweight effective imageUrl", async () => {
    const joinedTables: unknown[] = [];
    const cardRows = [
      {
        offeringId: 40,
        productId: 500,
        variantId: 501,
        productUnitId: 502,
        name: "كارت آسياسيل",
        providerId: 5,
        providerName: "آسياسيل",
        offeringType: "TELECOM_CARD",
        requiresStudentData: false,
        subscriptionDurationDays: null,
        faceValue: "10000.00",
        cardColorToken: null,
        priceValidityHours: null,
        isFavorite: true,
        displayOrder: 1,
        sellPrice: "10500.00",
        priceVersionId: 9,
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        offeringImageUrl: null,
        providerLogoUrl: VALID_PNG,
      },
      {
        offeringId: 41,
        productId: 503,
        variantId: 504,
        productUnitId: 505,
        name: "بطاقة مخصصة",
        providerId: 5,
        providerName: "آسياسيل",
        offeringType: "TELECOM_CARD",
        requiresStudentData: false,
        subscriptionDurationDays: null,
        faceValue: "25000.00",
        cardColorToken: null,
        priceValidityHours: null,
        isFavorite: false,
        displayOrder: 2,
        sellPrice: "26000.00",
        priceVersionId: 10,
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        offeringImageUrl: VALID_PNG_2,
        providerLogoUrl: VALID_PNG,
      },
    ];

    const makePosDb = () => {
      let step = 0;
      const db = {
        select: () => {
          step++;
          if (step === 1) return makeSelectChain([{ id: 1, isActive: true }]);
          const chain: any = {
            from: () => chain,
            innerJoin: (tbl: unknown) => {
              joinedTables.push(tbl);
              return chain;
            },
            leftJoin: (tbl: unknown) => {
              joinedTables.push(tbl);
              return chain;
            },
            where: () => chain,
            orderBy: () => Promise.resolve(cardRows),
          };
          return chain;
        },
      };
      return db as unknown as DB;
    };

    const cards = await listCards(makePosDb(), { branchId: 1 });
    expect(joinedTables).not.toContain(schema.productImages);
    expect(cards).toHaveLength(2);
    expect(cards[0].imageUrl).toBe(
      `/api/img/digital-offering/40?v=${digitalImageHash(VALID_PNG, "inherited")}`,
    );
    expect(cards[1].imageUrl).toBe(
      `/api/img/digital-offering/41?v=${digitalImageHash(VALID_PNG_2, "custom")}`,
    );
    expect(JSON.stringify(cards)).not.toContain("data:image/");

    const confirmed = await confirmCard(makePosDb(), { branchId: 1, offeringId: 40 });
    expect(confirmed.imageUrl).toBe(cards[0].imageUrl);
  });
});

describe("bodyParsers 3MB allowance for digitalCards providers & offerings", () => {
  it("allows ~2MB JSON on digitalCards.providers.* and digitalCards.offerings.* while keeping 1MB default elsewhere", async () => {
    const app = express();
    applyBodyParsers(app);
    app.post("/api/trpc/digitalCards.providers.update", (_req, res) => res.status(204).end());
    app.post("/api/trpc/digitalCards.offerings.create", (_req, res) => res.status(204).end());
    app.post("/api/trpc/auth.login", (_req, res) => res.status(204).end());

    const url = await listen(app);
    const body2MB = JSON.stringify({ payload: "A".repeat(2_100_000) });

    const provRes = await fetch(`${url}/api/trpc/digitalCards.providers.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body2MB,
    });
    expect(provRes.status).toBe(204);

    const offRes = await fetch(`${url}/api/trpc/digitalCards.offerings.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body2MB,
    });
    expect(offRes.status).toBe(204);

    const defaultRes = await fetch(`${url}/api/trpc/auth.login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "A".repeat(1_500_000) }),
    });
    expect(defaultRes.status).toBe(413);
  });
});

describe("client DigitalCardImage edit submission contract", () => {
  it("distinguishes unchanged (undefined), cleared (null), and newly uploaded (dataUrl)", () => {
    const existing = toExistingImageItems("/api/img/digital-provider/5?v=0123456789abcdef");
    expect(existing).toEqual([
      {
        id: "existing",
        dataUrl: "",
        url: "/api/img/digital-provider/5?v=0123456789abcdef",
        isPrimary: true,
      },
    ]);
    expect(toExistingImageItems(null)).toEqual([]);

    expect(resolveImageFormSubmission(existing)).toBeUndefined();
    expect(resolveImageFormSubmission([])).toBeNull();
    expect(
      resolveImageFormSubmission([
        { id: "new_1", dataUrl: VALID_PNG, isPrimary: true },
      ]),
    ).toBe(VALID_PNG);
  });
});
