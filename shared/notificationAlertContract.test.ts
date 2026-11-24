import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type PushEventStub = {
  data: { json: () => Record<string, unknown> };
  waitUntil: (work: Promise<void>) => void;
};

describe("notification alert contract", () => {
  it("lets the web platform produce the alert without accepting a custom sound", async () => {
    const source = readFileSync(
      new URL("../client/public/push-handler.js", import.meta.url),
      "utf8",
    );
    let pushListener: ((event: PushEventStub) => void) | undefined;
    let pending: Promise<void> | undefined;
    let shownOptions: Record<string, unknown> | undefined;
    const worker = {
      navigator: {},
      location: { origin: "https://erp.example" },
      registration: {
        showNotification: async (
          _title: string,
          options: Record<string, unknown>,
        ) => {
          shownOptions = options;
        },
      },
      addEventListener: (type: string, listener: unknown) => {
        if (type === "push") pushListener = listener as typeof pushListener;
      },
    };

    runInNewContext(source, { self: worker, clients: {} });
    expect(pushListener).toBeTypeOf("function");

    pushListener?.({
      data: {
        json: () => ({
          title: "تنبيه",
          body: "متابعة",
          sound: "/custom-notification.wav",
        }),
      },
      waitUntil: (work) => {
        pending = work;
      },
    });
    await pending;

    expect(shownOptions).toMatchObject({
      renotify: true,
      silent: false,
      vibrate: [150, 80, 150, 80, 250],
    });
    expect(shownOptions?.tag).toEqual(expect.any(String));
    expect((shownOptions?.tag as string).length).toBeGreaterThan(0);
    expect(shownOptions).not.toHaveProperty("sound");

    expect(
      existsSync(new URL("../client/public/notification.wav", import.meta.url)),
    ).toBe(false);
  });
});
