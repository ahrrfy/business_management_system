// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { RealtimeEvent } from "@shared/realtimeEvents";

const bus = vi.hoisted(() => new Map<string, (event: RealtimeEvent<any>) => void>());
vi.mock("../realtimeManager", () => ({ realtimeManager: {
  subscribe: (type: string, fn: (event: RealtimeEvent<any>) => void) => {
    bus.set(type, fn);
    return () => bus.delete(type);
  },
} }));
import { installFinancialQueryRefresh, invalidateFinancialQueries } from "../financialQueries";
import { REALTIME_EVENT_TYPES as E, createRealtimeEvent } from "@shared/realtimeEvents";

let client: QueryClient;
let stop: () => void;
let subscriptions: Array<() => void>;
let hidden = false;
const emit = (branchIds: number[] | null = null) => bus.get(E.FINANCIAL_DATA_CHANGED)?.(createRealtimeEvent(E.FINANCIAL_DATA_CHANGED, { branchIds }));
function read(root: string, branchId?: number, active = true, procedure: string | string[] = "list") {
  const queryKey = [[root, ...(Array.isArray(procedure) ? procedure : [procedure])], { input: branchId == null ? {} : { branchId }, type: "query" }];
  const queryFn = vi.fn(async () => ({ balance: "2000.25" }));
  client.setQueryData(queryKey, { balance: "1000.25" });
  const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: Infinity });
  if (active) subscriptions.push(observer.subscribe(() => {}));
  return { queryFn, queryKey, observer };
}
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  subscriptions = [];
  stop = installFinancialQueryRefresh(client);
});
afterEach(() => { stop(); subscriptions.forEach((off) => off()); client.clear(); bus.clear(); vi.useRealTimers(); });

describe("event-driven financial queries", () => {
  it.each(["local", "remote"])("refreshes every mounted order view after a %s delivery change without fetching unrelated store data", async source => {
    const orders = [
      ...["list", "counts", "detail", "myOrders"].map(procedure => read("storeAdmin", undefined, true, ["orders", procedure])),
      read("storeAdmin", undefined, true, ["analytics", "summary"]),
      read("storeAdmin", undefined, true, ["customers", "list"]),
    ];
    const inactive = read("storeAdmin", undefined, false, ["orders", "leaderboard"]);
    const otherBranch = read("storeAdmin", 3, true, ["orders", "list"]);
    const banners = read("storeAdmin", undefined, true, ["banners", "list"]);
    if (source === "local") await invalidateFinancialQueries(client, 2);
    else { emit([2]); await vi.advanceTimersByTimeAsync(750); }
    for (const query of orders) expect(query.queryFn).toHaveBeenCalledOnce();
    expect(client.getQueryState(inactive.queryKey)?.isInvalidated).toBe(true);
    for (const query of [inactive, otherBranch, banners]) expect(query.queryFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    for (const query of orders) expect(query.queryFn).toHaveBeenCalledOnce();
  });
  it.each(["local", "remote"])("refreshes return effects including branch stock and cashier quantities after a %s commit", async source => {
    const dependent = [
      read("sales", 2, true, "get"), read("returns", 2), read("customers", 2),
      read("delivery", 2), read("treasury", 2), read("inventory", 2, true, "onHand"),
      read("reports", 2, true, "customerStatement"), read("delivery", 2, true, "partyStatement"),
      read("delivery", 2, true, "partyFinancials"), read("delivery", 2, true, "openConsignments"),
      read("delivery", 2, true, "obligations"), read("delivery", 2, true, "remittances"),
      read("sales", 2, true, "lookupForCorrection"), read("returns", 2, true, "inspectInvoiceForReturn"),
      read("inventory", 2, true, "movementsRich"),
      read("storeAdmin", undefined, true, ["catalog", "list"]),
      ...["posList", "stockByUnitIds", "byUnitIds", "byProductIds", "adminList", "byBarcode", "forPurchase", "variantUnits", "getForVariantEdit"]
        .map(procedure => read("catalog", 2, true, procedure)),
    ];
    const inactiveStock = read("inventory", 2, false, "movements");
    const otherBranch = read("catalog", 3, true, "stockByUnitIds");
    const referenceData = read("catalog", 2, true, "productImages");
    const storefrontBanners = read("storeAdmin", undefined, true, ["banners", "list"]);
    if (source === "local") await invalidateFinancialQueries(client, 2);
    else { emit([2]); await vi.advanceTimersByTimeAsync(750); }
    for (const query of dependent) {
      expect(query.queryFn).toHaveBeenCalledOnce();
      expect(query.observer.getCurrentResult().data).toEqual({ balance: "2000.25" });
    }
    expect(client.getQueryState(inactiveStock.queryKey)?.isInvalidated).toBe(true);
    for (const query of [inactiveStock, otherBranch, referenceData, storefrontBanners]) expect(query.queryFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    for (const query of dependent) expect(query.queryFn).toHaveBeenCalledOnce();
  });
  it("refreshes current invoice, lists and delivery once after a local mutation while marking inactive caches stale", async () => {
    const detail = read("sales", undefined, true, "get");
    const list = read("sales", 2, true, "listPage");
    const delivery = read("delivery", 2);
    const reception = read("reception", 2, false, "invoiceQueue");
    const other = read("sales", 3);
    const catalog = read("catalog", 2);
    const heavy = read("reports", 2, true, "managementAlerts");
    await invalidateFinancialQueries(client, 2);
    for (const q of [detail, list, delivery]) expect(q.queryFn).toHaveBeenCalledOnce();
    for (const q of [reception, other, catalog, heavy]) expect(q.queryFn).not.toHaveBeenCalled();
    expect(client.getQueryState(reception.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(heavy.queryKey)?.isInvalidated).toBe(true);
  });
  it("refreshes heavy alerts automatically after one snapshot window and keeps money KPIs immediate", async () => {
    const heavy = read("reports", undefined, true, "managementAlerts");
    const executive = read("executive", undefined, true, "commandCenter");
    emit();
    expect(client.getQueryState(heavy.queryKey)?.isInvalidated).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(heavy.queryFn).not.toHaveBeenCalled();
    expect(executive.queryFn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_300);
    expect(heavy.queryFn).toHaveBeenCalledOnce();
    expect(executive.queryFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heavy.queryFn).toHaveBeenCalledOnce();
    expect(executive.queryFn).toHaveBeenCalledTimes(2);
  });
  it("does not turn continuous financial events into expensive alert queries every two seconds", async () => {
    const heavy = read("reports", undefined, true, "managementAlerts");
    for (let i = 0; i < 900; i++) { emit(); await vi.advanceTimersByTimeAsync(100); }
    expect(heavy.queryFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_100);
    expect(heavy.queryFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heavy.queryFn).toHaveBeenCalledTimes(3);
  });
  it("updates a mounted financial view after another device's event without reloading or polling", async () => {
    const { queryFn, observer } = read("treasury");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).not.toHaveBeenCalled();
    emit();
    await vi.advanceTimersByTimeAsync(750);
    expect(queryFn).toHaveBeenCalledOnce();
    expect(observer.getCurrentResult().data).toEqual({ balance: "2000.25" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).toHaveBeenCalledOnce();
  });
  it("batches hundreds of commits and limits continuous updates without starvation", async () => {
    const { queryFn } = read("reports");
    for (let i = 0; i < 300; i++) emit();
    await vi.advanceTimersByTimeAsync(750);
    expect(queryFn).toHaveBeenCalledOnce();
    for (let i = 0; i < 20; i++) { emit(); await vi.advanceTimersByTimeAsync(100); }
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
  it("does not fetch inactive, disabled or unrelated queries and preserves branch filters", async () => {
    const same = read("treasury", 1);
    const other = read("treasury", 2);
    const company = read("reports");
    const inactive = read("accounts", undefined, false);
    const unrelated = read("catalog");
    const disabled = read("payroll", undefined, false);
    subscriptions.push(disabled.observer.subscribe(() => {}));
    disabled.observer.setOptions({ ...disabled.observer.options, enabled: false });
    emit([1]);
    await vi.advanceTimersByTimeAsync(750);
    expect(same.queryFn).toHaveBeenCalledOnce();
    expect(company.queryFn).toHaveBeenCalledOnce();
    for (const q of [other, inactive, unrelated, disabled]) expect(q.queryFn).not.toHaveBeenCalled();
    expect(client.getQueryState(inactive.queryKey)?.isInvalidated).toBe(true);
  });
  it("defers hidden work then repairs missed changes on returning to the screen", async () => {
    const { queryFn } = read("treasury");
    hidden = true;
    emit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).not.toHaveBeenCalled();
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(750);
    expect(queryFn).toHaveBeenCalledOnce();
  });
  it.each([E.CONNECTED, E.RESYNC_REQUIRED])("repairs missed events on %s without periodic requests", async (type) => {
    const { queryFn } = read("accounts");
    bus.get(type)?.(createRealtimeEvent(type, {}));
    await vi.advanceTimersByTimeAsync(750);
    expect(queryFn).toHaveBeenCalledOnce();
  });
  it("keeps the final update when another event arrives during a slow fetch", async () => {
    const { queryFn, queryKey } = read("treasury");
    let resolve!: (value: { balance: string }) => void;
    queryFn.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    emit();
    await vi.advanceTimersByTimeAsync(750);
    emit();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queryFn).toHaveBeenCalledOnce();
    resolve({ balance: "1500.25" });
    await vi.advanceTimersByTimeAsync(750);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(queryKey)).toEqual({ balance: "2000.25" });
  });
  it("cleans subscriptions and queued refreshes on disposal", async () => {
    const { queryFn } = read("treasury");
    emit(); stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queryFn).not.toHaveBeenCalled();
    expect(bus.size).toBe(0);
  });
  it("repairs an overlapping snapshot once without looping on continuous external fetches", async () => {
    const { queryFn, queryKey } = read("treasury");
    let resolve!: (value: { balance: string }) => void;
    queryFn.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const first = client.refetchQueries({ queryKey });
    emit();
    await vi.advanceTimersByTimeAsync(750);
    resolve({ balance: "1500.25" });
    await first;
    await vi.advanceTimersByTimeAsync(0);
    const second = client.refetchQueries({ queryKey });
    await vi.advanceTimersByTimeAsync(2_000);
    resolve({ balance: "2000.25" });
    await second;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    // A new real event still refreshes normally after the bounded repair.
    queryFn.mockResolvedValue({ balance: "2500.25" });
    emit();
    await vi.advanceTimersByTimeAsync(750);
    expect(client.getQueryData(queryKey)).toEqual({ balance: "2500.25" });
  });
});
