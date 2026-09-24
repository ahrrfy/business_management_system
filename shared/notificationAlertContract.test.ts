import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type PushEventStub = {
  data: { json: () => Record<string, unknown> };
  waitUntil: (work: Promise<void>) => void;
};

function activeKotlinSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\r\n]*/gu, "");
}

type NotifiedBuilderContract = {
  block: string;
  initializer: string;
};

function fluentInitializerEnd(source: string, declarationIndex: number) {
  const constructorStart = source.indexOf(
    "NotificationCompat.Builder(",
    declarationIndex,
  );
  if (constructorStart < 0) return undefined;

  let parenthesisDepth = 0;
  for (
    let index = source.indexOf("(", constructorStart);
    index < source.length;
    index += 1
  ) {
    if (source[index] === "(") parenthesisDepth += 1;
    if (source[index] !== ")") continue;

    parenthesisDepth -= 1;
    if (parenthesisDepth !== 0) continue;

    let nextToken = index + 1;
    while (/\s/u.test(source[nextToken] ?? "")) nextToken += 1;
    if (source[nextToken] !== ".") return index + 1;
  }

  return undefined;
}

function notifiedBuilderContract(
  source: string,
): NotifiedBuilderContract | undefined {
  const activeSource = activeKotlinSource(source);
  const notifyCall = activeSource.match(
    /NotificationManagerCompat\.from\([^)]*\)\.notify\(\s*[^,]+,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/u,
  );
  if (!notifyCall) return undefined;

  const notificationName = notifyCall[1];
  const buildAssignment = activeSource.match(
    new RegExp(
      `val\\s+${notificationName}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)\\.build\\(\\)`,
      "u",
    ),
  );
  if (buildAssignment?.index === undefined) return undefined;

  const builderName = buildAssignment[1];
  const declaration = activeSource.match(
    new RegExp(
      `val\\s+${builderName}\\s*=\\s*NotificationCompat\\.Builder\\(`,
      "u",
    ),
  );
  if (
    declaration?.index === undefined ||
    declaration.index > buildAssignment.index
  ) {
    return undefined;
  }

  const initializerEnd = fluentInitializerEnd(activeSource, declaration.index);
  if (initializerEnd === undefined || initializerEnd > buildAssignment.index) {
    return undefined;
  }

  return {
    block: activeSource.slice(declaration.index, buildAssignment.index),
    initializer: activeSource.slice(declaration.index, initializerEnd),
  };
}

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

  it("uses Android system defaults while suppressing repeat alerts", () => {
    const rendererUrl = new URL(
      "../android-native/app/src/main/java/online/alarabiya/superapp/core/notifications/NativeNotificationRenderer.kt",
      import.meta.url,
    );
    if (!existsSync(rendererUrl)) {
      const superappConfig = readFileSync(
        new URL("../expo/superapp-mobile/app.config.js", import.meta.url),
        "utf8",
      );
      const storeNotifications = readFileSync(
        new URL(
          "../expo/customer-store-mobile/lib/customer-notifications.ts",
          import.meta.url,
        ),
        "utf8",
      );

      expect(superappConfig).toContain("expo-notifications");
      expect(superappConfig).toContain('defaultChannel: "super_arabia_updates"');
      expect(storeNotifications).toContain('sound: "default"');
      expect(storeNotifications).toContain(
        "importance: Notifications.AndroidImportance.HIGH",
      );
      return;
    }

    const rendererSource = readFileSync(rendererUrl, "utf8");
    const channelsSource = activeKotlinSource(
      readFileSync(
        new URL(
          "../android-native/app/src/main/java/online/alarabiya/superapp/core/notifications/AppNotificationChannels.kt",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const manifestSource = readFileSync(
      new URL(
        "../android-native/app/src/main/AndroidManifest.xml",
        import.meta.url,
      ),
      "utf8",
    );
    const guardedBuilder = notifiedBuilderContract(rendererSource);

    expect(guardedBuilder?.initializer).toMatch(
      /\.setDefaults\(\s*NotificationCompat\.DEFAULT_ALL\s*\)/u,
    );
    expect(guardedBuilder?.initializer).toMatch(
      /\.setOnlyAlertOnce\(\s*true\s*\)/u,
    );
    expect(guardedBuilder?.block.match(/\.setDefaults\(/gu)).toHaveLength(1);
    expect(guardedBuilder?.block.match(/\.setOnlyAlertOnce\(/gu)).toHaveLength(
      1,
    );
    expect(guardedBuilder?.block).not.toMatch(/\.setSilent\(\s*true\s*\)/u);

    const usedChannels = [
      ...activeKotlinSource(rendererSource).matchAll(
        /->\s*AppNotificationChannels\.([A-Z][A-Z0-9_]*)/gu,
      ),
    ].map((match) => match[1]);
    const channelStarts = [
      ...channelsSource.matchAll(
        /NotificationChannel\(\s*([A-Z][A-Z0-9_]*)\s*,/gu,
      ),
    ];
    const channelBlocks = new Map(
      channelStarts.map((match, index) => [
        match[1],
        channelsSource.slice(
          match.index,
          channelStarts[index + 1]?.index ?? channelsSource.length,
        ),
      ]),
    );

    expect(usedChannels.length).toBeGreaterThan(0);
    for (const channel of usedChannels) {
      const block = channelBlocks.get(channel);
      expect(block, `${channel} must be created`).toBeDefined();
      expect(block?.match(/NotificationManager\.IMPORTANCE_[A-Z_]+/gu)).toEqual(
        ["NotificationManager.IMPORTANCE_HIGH"],
      );
      expect(block).not.toMatch(/\.setSound\(/u);
    }

    const defaultChannelMetadata = manifestSource
      .match(/<meta-data\b[^>]*>/gu)
      ?.find((tag) =>
        tag.includes(
          'android:name="com.google.firebase.messaging.default_notification_channel_id"',
        ),
      );
    const defaultChannel = defaultChannelMetadata?.match(
      /android:value="([^"]+)"/u,
    )?.[1];
    const declaredChannelIds = new Set(
      [
        ...channelsSource.matchAll(/const val [A-Z][A-Z0-9_]* = "([^"]+)"/gu),
      ].map((match) => match[1]),
    );

    expect(defaultChannel).toBeDefined();
    expect(declaredChannelIds).toContain(defaultChannel);
  });
});
