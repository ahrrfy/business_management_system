// خدمة تسعير الطباعة الرقمية — طبقة القاعدة: قراءة الإعدادات + محمّل الحاسبة + CRUD الإعدادات.
// الحساب النقيّ في compute.ts. كل الكتابات ذرّية (withTx). محصورة بالمدير في الراوتر.
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  printFacePrices,
  printFinishingOptions,
  printPaperUpcharges,
  printPricingSettings,
  printWideMedia,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { toDbMoney } from "../money";
import { withTx } from "../tx";
import { computePrintEstimate, type ResolvedFinishing } from "./compute";
import type {
  ColorMode,
  FinishingUnit,
  PaperSizeCode,
  PaperUpchargeUnit,
  PricingMode,
  PrintEstimateInput,
  PrintEstimateResult,
} from "@shared/printPricing";

export { computePrintEstimate } from "./compute";
export type { ResolvedEstimateConfig } from "./compute";

// ─── قراءة الإعدادات ────────────────────────────────────────────────────────

export interface PrintPricingSettingsRow {
  pricingMode: PricingMode;
  defaultMarginPercent: string;
  setupFee: string;
}

/** الصفّ المفرد أو الافتراضات (وضع الهامش، صفر هامش/تجهيز) — لا يُنشئ صفّاً. */
async function readSettings(): Promise<PrintPricingSettingsRow> {
  const db = getDb();
  const row = db
    ? (
        await db
          .select({
            pricingMode: printPricingSettings.pricingMode,
            defaultMarginPercent: printPricingSettings.defaultMarginPercent,
            setupFee: printPricingSettings.setupFee,
          })
          .from(printPricingSettings)
          .orderBy(asc(printPricingSettings.id))
          .limit(1)
      )[0]
    : undefined;
  return {
    pricingMode: (row?.pricingMode as PricingMode) ?? "MARGIN",
    defaultMarginPercent: row?.defaultMarginPercent ?? "0",
    setupFee: row?.setupFee ?? "0",
  };
}

export interface FacePriceRow {
  id: number;
  paperSize: PaperSizeCode;
  colorMode: ColorMode;
  pricePerFace: string;
}
export interface PaperUpchargeRow {
  id: number;
  name: string;
  unit: PaperUpchargeUnit;
  upcharge: string;
  isActive: boolean;
}
export interface WideMediaRow {
  id: number;
  name: string;
  pricePerSqm: string;
  isActive: boolean;
}
export interface FinishingRow {
  id: number;
  name: string;
  unit: FinishingUnit;
  price: string;
  isActive: boolean;
}

export interface PrintPricingBundle {
  settings: PrintPricingSettingsRow;
  facePrices: FacePriceRow[];
  paperUpcharges: PaperUpchargeRow[];
  wideMedia: WideMediaRow[];
  finishings: FinishingRow[];
}

/** كل الإعدادات دفعةً — لشاشة الإعدادات ولملء قوائم الحاسبة (تُصفّي isActive عندها). */
export async function getPrintPricingBundle(): Promise<PrintPricingBundle> {
  const db = getDb();
  if (!db) {
    return { settings: await readSettings(), facePrices: [], paperUpcharges: [], wideMedia: [], finishings: [] };
  }
  const [settings, facePrices, paperUpcharges, wideMedia, finishings] = await Promise.all([
    readSettings(),
    db
      .select({
        id: printFacePrices.id,
        paperSize: printFacePrices.paperSize,
        colorMode: printFacePrices.colorMode,
        pricePerFace: printFacePrices.pricePerFace,
      })
      .from(printFacePrices)
      .orderBy(asc(printFacePrices.paperSize), asc(printFacePrices.colorMode)),
    db
      .select({
        id: printPaperUpcharges.id,
        name: printPaperUpcharges.name,
        unit: printPaperUpcharges.unit,
        upcharge: printPaperUpcharges.upcharge,
        isActive: printPaperUpcharges.isActive,
      })
      .from(printPaperUpcharges)
      .orderBy(asc(printPaperUpcharges.name)),
    db
      .select({
        id: printWideMedia.id,
        name: printWideMedia.name,
        pricePerSqm: printWideMedia.pricePerSqm,
        isActive: printWideMedia.isActive,
      })
      .from(printWideMedia)
      .orderBy(asc(printWideMedia.name)),
    db
      .select({
        id: printFinishingOptions.id,
        name: printFinishingOptions.name,
        unit: printFinishingOptions.unit,
        price: printFinishingOptions.price,
        isActive: printFinishingOptions.isActive,
      })
      .from(printFinishingOptions)
      .orderBy(asc(printFinishingOptions.name)),
  ]);
  return {
    settings,
    facePrices: facePrices as FacePriceRow[],
    paperUpcharges: paperUpcharges as PaperUpchargeRow[],
    wideMedia: wideMedia as WideMediaRow[],
    finishings: finishings as FinishingRow[],
  };
}

// ─── محمّل الحاسبة ──────────────────────────────────────────────────────────

function requireDb() {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة." });
  return db;
}

/** يحلّ خيارات التشطيب المختارة (فعّالة فقط، بترتيب الإدخال). يرمي إن اختير خيار محذوف/معطّل. */
async function resolveFinishings(finishingIds: number[] | undefined): Promise<ResolvedFinishing[]> {
  if (!finishingIds || finishingIds.length === 0) return [];
  const db = requireDb();
  const rows = await db
    .select({
      id: printFinishingOptions.id,
      name: printFinishingOptions.name,
      unit: printFinishingOptions.unit,
      price: printFinishingOptions.price,
      isActive: printFinishingOptions.isActive,
    })
    .from(printFinishingOptions)
    .where(inArray(printFinishingOptions.id, finishingIds));
  const byId = new Map(rows.filter((r) => r.isActive).map((r) => [r.id, r]));
  return finishingIds.map((id) => {
    const r = byId.get(id);
    if (!r) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "خيار تشطيب غير موجود أو معطّل — حدّث القائمة." });
    }
    return { name: r.name, unit: r.unit as FinishingUnit, price: r.price };
  });
}

/** الحاسبة: يحمّل الإعدادات والصفوف المطلوبة ثم يحسب (نقيّاً). */
export async function estimatePrint(input: PrintEstimateInput): Promise<PrintEstimateResult> {
  const db = requireDb();
  const settings = await readSettings();

  if (input.category === "SMALL") {
    const [faceRow, finishings] = await Promise.all([
      db
        .select({ pricePerFace: printFacePrices.pricePerFace })
        .from(printFacePrices)
        .where(and(eq(printFacePrices.paperSize, input.paperSize), eq(printFacePrices.colorMode, input.colorMode)))
        .limit(1),
      resolveFinishings(input.finishingIds),
    ]);

    let paperUpcharge = null;
    if (input.paperUpchargeId != null) {
      const pu = (
        await db
          .select({
            name: printPaperUpcharges.name,
            unit: printPaperUpcharges.unit,
            upcharge: printPaperUpcharges.upcharge,
            isActive: printPaperUpcharges.isActive,
          })
          .from(printPaperUpcharges)
          .where(eq(printPaperUpcharges.id, input.paperUpchargeId))
          .limit(1)
      )[0];
      if (!pu || !pu.isActive) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الورق المميّز المختار غير موجود أو معطّل." });
      }
      paperUpcharge = { name: pu.name, unit: pu.unit as PaperUpchargeUnit, upcharge: pu.upcharge };
    }

    return computePrintEstimate(input, {
      settings,
      facePrice: faceRow[0]?.pricePerFace, // undefined ⇒ compute يرمي رسالة «أضِف سعر الوجه».
      paperUpcharge,
      finishings,
    });
  }

  // WIDE
  const [mediaRow, finishings] = await Promise.all([
    db
      .select({ name: printWideMedia.name, pricePerSqm: printWideMedia.pricePerSqm, isActive: printWideMedia.isActive })
      .from(printWideMedia)
      .where(eq(printWideMedia.id, input.mediaId))
      .limit(1),
    resolveFinishings(input.finishingIds),
  ]);
  const media = mediaRow[0];
  if (!media || !media.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وسيط الطباعة العريضة المختار غير موجود أو معطّل." });
  }
  return computePrintEstimate(input, {
    settings,
    media: { name: media.name, pricePerSqm: media.pricePerSqm },
    finishings,
  });
}

// ─── CRUD الإعدادات (المدير) ────────────────────────────────────────────────

export interface UpdateSettingsInput {
  pricingMode?: PricingMode;
  defaultMarginPercent?: string;
  setupFee?: string;
}

/** يكتب/يُحدّث الصفّ المفرد (get-or-create، نمط taxSettings). */
export async function updatePrintPricingSettings(input: UpdateSettingsInput, updatedBy: number): Promise<void> {
  await withTx(async (tx) => {
    const existing = (
      await tx.select({ id: printPricingSettings.id }).from(printPricingSettings).orderBy(asc(printPricingSettings.id)).limit(1)
    )[0];
    const patch: Record<string, unknown> = { updatedBy };
    if (input.pricingMode !== undefined) patch.pricingMode = input.pricingMode;
    if (input.defaultMarginPercent !== undefined) patch.defaultMarginPercent = input.defaultMarginPercent;
    if (input.setupFee !== undefined) patch.setupFee = toDbMoney(input.setupFee);
    if (existing) {
      await tx.update(printPricingSettings).set(patch).where(eq(printPricingSettings.id, existing.id));
    } else {
      await tx.insert(printPricingSettings).values({
        pricingMode: input.pricingMode ?? "MARGIN",
        defaultMarginPercent: input.defaultMarginPercent ?? "0",
        setupFee: input.setupFee !== undefined ? toDbMoney(input.setupFee) : "0",
        updatedBy,
      });
    }
  });
}

/** يضبط سعر الوجه لـ(المقاس، النمط) — upsert (تعديل الموجود بدل صفٍّ مكرّر). */
export async function upsertFacePrice(
  input: { paperSize: PaperSizeCode; colorMode: ColorMode; pricePerFace: string },
  updatedBy: number,
): Promise<void> {
  await withTx(async (tx) => {
    const existing = (
      await tx
        .select({ id: printFacePrices.id })
        .from(printFacePrices)
        .where(and(eq(printFacePrices.paperSize, input.paperSize), eq(printFacePrices.colorMode, input.colorMode)))
        .limit(1)
    )[0];
    if (existing) {
      await tx
        .update(printFacePrices)
        .set({ pricePerFace: toDbMoney(input.pricePerFace), updatedBy })
        .where(eq(printFacePrices.id, existing.id));
    } else {
      await tx.insert(printFacePrices).values({
        paperSize: input.paperSize,
        colorMode: input.colorMode,
        pricePerFace: toDbMoney(input.pricePerFace),
        updatedBy,
      });
    }
  });
}

/** يحذف سعر وجهٍ (يُلغي تسعير مقاس/نمط). */
export async function deleteFacePrice(id: number): Promise<void> {
  await withTx(async (tx) => {
    await tx.delete(printFacePrices).where(eq(printFacePrices.id, id));
  });
}

/** ورق مميّز — إنشاء/تعديل (تعطيل = isActive:false). */
export async function createPaperUpcharge(input: {
  name: string;
  unit: PaperUpchargeUnit;
  upcharge: string;
}): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const res = await tx
      .insert(printPaperUpcharges)
      .values({ name: input.name.trim(), unit: input.unit, upcharge: toDbMoney(input.upcharge) });
    return { id: extractInsertId(res) };
  });
}

export async function updatePaperUpcharge(input: {
  id: number;
  name?: string;
  unit?: PaperUpchargeUnit;
  upcharge?: string;
  isActive?: boolean;
}): Promise<void> {
  await withTx(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.unit !== undefined) patch.unit = input.unit;
    if (input.upcharge !== undefined) patch.upcharge = toDbMoney(input.upcharge);
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (Object.keys(patch).length === 0) return;
    await tx.update(printPaperUpcharges).set(patch).where(eq(printPaperUpcharges.id, input.id));
  });
}

/** وسيط عريض — إنشاء/تعديل. */
export async function createWideMedia(input: { name: string; pricePerSqm: string }): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const res = await tx
      .insert(printWideMedia)
      .values({ name: input.name.trim(), pricePerSqm: toDbMoney(input.pricePerSqm) });
    return { id: extractInsertId(res) };
  });
}

export async function updateWideMedia(input: {
  id: number;
  name?: string;
  pricePerSqm?: string;
  isActive?: boolean;
}): Promise<void> {
  await withTx(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.pricePerSqm !== undefined) patch.pricePerSqm = toDbMoney(input.pricePerSqm);
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (Object.keys(patch).length === 0) return;
    await tx.update(printWideMedia).set(patch).where(eq(printWideMedia.id, input.id));
  });
}

/** خيار تشطيب — إنشاء/تعديل. */
export async function createFinishing(input: {
  name: string;
  unit: FinishingUnit;
  price: string;
}): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const res = await tx
      .insert(printFinishingOptions)
      .values({ name: input.name.trim(), unit: input.unit, price: toDbMoney(input.price) });
    return { id: extractInsertId(res) };
  });
}

export async function updateFinishing(input: {
  id: number;
  name?: string;
  unit?: FinishingUnit;
  price?: string;
  isActive?: boolean;
}): Promise<void> {
  await withTx(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.unit !== undefined) patch.unit = input.unit;
    if (input.price !== undefined) patch.price = toDbMoney(input.price);
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (Object.keys(patch).length === 0) return;
    await tx.update(printFinishingOptions).set(patch).where(eq(printFinishingOptions.id, input.id));
  });
}
