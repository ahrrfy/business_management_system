import { describe, expect, it, vi } from "vitest";
import { ConnectivityMachine } from "./connectivity";

describe("ConnectivityMachine — آلة حالة كشف الاتصال (ش١ أوفلاين)", () => {
  it("تبدأ online افتراضياً وoffline عندما يبدأ المتصفح مقطوعاً", () => {
    expect(new ConnectivityMachine().get()).toBe("online");
    expect(new ConnectivityMachine(false).get()).toBe("offline");
  });

  it("فشل نقل فعلي يقلبها offline فوراً", () => {
    const m = new ConnectivityMachine();
    m.noteFailure();
    expect(m.get()).toBe("offline");
  });

  it("حدث المتصفح online لا يعيد online مباشرة بل reconnecting (تلميح غير موثوق)", () => {
    const m = new ConnectivityMachine();
    m.noteFailure();
    m.noteBrowserOnline();
    expect(m.get()).toBe("reconnecting");
  });

  it("نجاح مسبار/نداء أثناء reconnecting يعلن العودة online", () => {
    const m = new ConnectivityMachine();
    m.noteFailure();
    m.noteBrowserOnline();
    m.noteSuccess();
    expect(m.get()).toBe("online");
  });

  it("فشل المسبار أثناء reconnecting يعيدها offline (العودة لم تتحقق)", () => {
    const m = new ConnectivityMachine();
    m.noteFailure();
    m.noteBrowserOnline();
    m.noteFailure();
    expect(m.get()).toBe("offline");
  });

  it("حدث المتصفح online وهي online أصلاً لا يغيّر شيئاً", () => {
    const m = new ConnectivityMachine();
    m.noteBrowserOnline();
    expect(m.get()).toBe("online");
  });

  it("المشترك يُخطَر عند كل تغيّر فعلي فقط (لا إخطار على تكرار نفس الحالة)", () => {
    const m = new ConnectivityMachine();
    const seen: string[] = [];
    m.subscribe((s) => seen.push(s));
    m.noteFailure();
    m.noteFailure(); // تكرار — لا إخطار
    m.noteBrowserOnline();
    m.noteSuccess();
    m.noteSuccess(); // تكرار — لا إخطار
    expect(seen).toEqual(["offline", "reconnecting", "online"]);
  });

  it("إلغاء الاشتراك يوقف الإخطارات", () => {
    const m = new ConnectivityMachine();
    const cb = vi.fn();
    const off = m.subscribe(cb);
    m.noteFailure();
    off();
    m.noteSuccess();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("syncing: تُفعَّل من online وتعود إليها عند الإطفاء", () => {
    const m = new ConnectivityMachine();
    m.setSyncing(true);
    expect(m.get()).toBe("syncing");
    m.setSyncing(false);
    expect(m.get()).toBe("online");
  });

  it("syncing: نجاح نداء أثناءها لا يُسقطها (تبقى أدقّ وصفاً حتى فراغ الطابور)", () => {
    const m = new ConnectivityMachine();
    m.setSyncing(true);
    m.noteSuccess();
    expect(m.get()).toBe("syncing");
  });

  it("syncing: فشل نقل أثناءها يقلبها offline (المزامنة انقطعت)", () => {
    const m = new ConnectivityMachine();
    m.setSyncing(true);
    m.noteFailure();
    expect(m.get()).toBe("offline");
  });

  it("syncing لا تُفعَّل من حالة offline (لا مزامنة بلا اتصال)", () => {
    const m = new ConnectivityMachine();
    m.noteFailure();
    m.setSyncing(true);
    expect(m.get()).toBe("offline");
  });
});
