import { describe, expect, it } from "vitest";
import {
  NAV_FAVORITES_LIMIT,
  NAV_RECENT_LIMIT,
  filterNavWorkspace,
  loadNavWorkspace,
  navWorkspaceStorageKey,
  recordRecent,
  resolveNavRoot,
  saveNavWorkspace,
  toggleFavorite,
  type NavWorkspace,
} from "./navWorkspace";

const ALLOWED = ["/pos", "/invoices", "/inventory", "/work-orders"];

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    value: (key: string) => values.get(key),
  };
}

describe("navWorkspace — العزل والتخزين الآمن", () => {
  it("يعزل المفتاح حسب الشركة والمستخدم", () => {
    expect(navWorkspaceStorageKey(7, "ACME")).toBe("erp.navWorkspace.v1:acme:7");
    expect(navWorkspaceStorageKey(7, "ACME")).not.toBe(navWorkspaceStorageKey(8, "ACME"));
    expect(navWorkspaceStorageKey(7, "ACME")).not.toBe(navWorkspaceStorageKey(7, "OTHER"));
  });

  it("يفشل مغلقاً عند JSON تالف ويزيل الروابط غير المصرّح بها والخطرة والتكرار", () => {
    const key = navWorkspaceStorageKey(1, null);
    const broken = memoryStorage({ [key]: "{" });
    expect(loadNavWorkspace(broken, key, ALLOWED)).toEqual({ favorites: [], recent: [] });

    const tampered = memoryStorage({
      [key]: JSON.stringify({
        favorites: ["/invoices", "/admin", "https://evil.example", "/invoices"],
        recent: ["/pos", "/invoices/991", "javascript:alert(1)"],
      }),
    });
    expect(loadNavWorkspace(tampered, key, ALLOWED)).toEqual({
      favorites: ["/invoices"],
      recent: ["/pos"],
    });
  });

  it("يعيد ترشيح المخزون عند تغيّر صلاحيات الدور", () => {
    const workspace = { favorites: ["/pos", "/inventory"], recent: ["/invoices", "/pos"] };
    expect(filterNavWorkspace(workspace, ["/pos"])).toEqual({ favorites: ["/pos"], recent: ["/pos"] });
  });

  it("يحفظ مصفوفتَي مسارات فقط ويتحمّل فشل localStorage", () => {
    const key = navWorkspaceStorageKey(2, "co");
    const storage = memoryStorage();
    saveNavWorkspace(
      storage,
      key,
      { favorites: ["/pos", "/admin", "/pos?token=x"], recent: ["/inventory", "/invoices/991"] },
      ALLOWED,
    );
    expect(JSON.parse(storage.value(key) ?? "null")).toEqual({ favorites: ["/pos"], recent: ["/inventory"] });

    expect(() => saveNavWorkspace(
      { setItem: () => { throw new Error("quota"); } },
      key,
      { favorites: ["/pos"], recent: [] },
      ALLOWED,
    )).not.toThrow();
  });
});

describe("navWorkspace — المفضلة والحديثة", () => {
  it("يضيف ويحذف المفضلة ولا يتجاوز الحد", () => {
    let workspace: NavWorkspace = { favorites: [], recent: [] };
    workspace = toggleFavorite(workspace, "/pos");
    expect(workspace.favorites).toEqual(["/pos"]);
    expect(toggleFavorite(workspace, "/pos").favorites).toEqual([]);

    const full: NavWorkspace = {
      favorites: Array.from({ length: NAV_FAVORITES_LIMIT }, (_, i) => `/p-${i}`),
      recent: [],
    };
    expect(toggleFavorite(full, "/extra")).toBe(full);
  });

  it("يرفع الأحدث للأعلى بلا تكرار وبحد ثابت", () => {
    let workspace: NavWorkspace = { favorites: [], recent: [] };
    for (let i = 0; i < NAV_RECENT_LIMIT + 2; i += 1) workspace = recordRecent(workspace, `/p-${i}`);
    expect(workspace.recent).toHaveLength(NAV_RECENT_LIMIT);
    workspace = recordRecent(workspace, "/p-3");
    expect(workspace.recent[0]).toBe("/p-3");
    expect(workspace.recent.filter((path) => path === "/p-3")).toHaveLength(1);
  });

  it("يختزل شاشة التفاصيل إلى جذر ثابت ولا يخزّن المعرّف أو query", () => {
    expect(resolveNavRoot("/invoices/991?print=1", ALLOWED)).toBe("/invoices");
    expect(resolveNavRoot("/inventory?tab=stock", ALLOWED)).toBe("/inventory");
    expect(resolveNavRoot("/products/991/edit?tab=units", ALLOWED)).toBe("/inventory");
    expect(resolveNavRoot("/products/new", ALLOWED)).toBe("/inventory");
    expect(resolveNavRoot("/products/991/edit", ["/pos"])).toBeNull();
    expect(resolveNavRoot("/products-secret/991", ALLOWED)).toBeNull();
    expect(resolveNavRoot("/unknown/secret", ALLOWED)).toBeNull();
  });
});
