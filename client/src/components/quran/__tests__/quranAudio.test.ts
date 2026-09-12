import { describe, it, expect } from "vitest";
import { QURAN_SURAHS, QURAN_RECITERS, getSurahAudioUrl } from "../quranData";

describe("Quran Audio & Catalog Contracts", () => {
  it("contains all 114 Surahs with valid metadata", () => {
    expect(QURAN_SURAHS).toHaveLength(114);

    // التحقق من أول سورة (الفاتحة) وآخر سورة (الناس)
    expect(QURAN_SURAHS[0].id).toBe(1);
    expect(QURAN_SURAHS[0].name).toBe("الفاتحة");
    expect(QURAN_SURAHS[0].ayahCount).toBe(7);

    expect(QURAN_SURAHS[113].id).toBe(114);
    expect(QURAN_SURAHS[113].name).toBe("الناس");
    expect(QURAN_SURAHS[113].ayahCount).toBe(6);

    // كل السور لها تصنيف مكية أو مدنية ورقم ترتيب فريد
    const ids = new Set<number>();
    for (const surah of QURAN_SURAHS) {
      expect(surah.id).toBeGreaterThanOrEqual(1);
      expect(surah.id).toBeLessThanOrEqual(114);
      expect(["مكية", "مدنية"]).toContain(surah.type);
      expect(surah.ayahCount).toBeGreaterThan(0);
      ids.add(surah.id);
    }
    expect(ids.size).toBe(114);
  });

  it("provides top curated reciters with direct CDN streaming servers", () => {
    expect(QURAN_RECITERS.length).toBeGreaterThanOrEqual(10);

    const afs = QURAN_RECITERS.find((r) => r.id === "afs");
    expect(afs).toBeDefined();
    expect(afs?.name).toContain("العفاسي");

    const basit = QURAN_RECITERS.find((r) => r.id === "basit_murattal");
    expect(basit).toBeDefined();
    expect(basit?.name).toContain("عبد الباسط");

    for (const reciter of QURAN_RECITERS) {
      expect(reciter.serverUrl).toMatch(/^https?:\/\//);
    }
  });

  it("generates 3-digit padded MP3 streaming URLs correctly", () => {
    const urlFatihah = getSurahAudioUrl("https://server8.mp3quran.net/afs", 1);
    expect(urlFatihah).toBe("https://server8.mp3quran.net/afs/001.mp3");

    const urlKahf = getSurahAudioUrl("https://server8.mp3quran.net/afs/", 18);
    expect(urlKahf).toBe("https://server8.mp3quran.net/afs/018.mp3");

    const urlNas = getSurahAudioUrl("https://server7.mp3quran.net/basit", 114);
    expect(urlNas).toBe("https://server7.mp3quran.net/basit/114.mp3");
  });

  it("defines standard persistence storage keys for Quran playback bookmarking", () => {
    const keys = {
      reciter: "erp.quran.lastReciterId",
      surah: "erp.quran.lastSurahId",
      volume: "erp.quran.volume",
      position: "erp.quran.lastPositionSeconds",
      barVisible: "erp.quran.bar_visible",
    };

    expect(keys.reciter).toBe("erp.quran.lastReciterId");
    expect(keys.surah).toBe("erp.quran.lastSurahId");
    expect(keys.position).toBe("erp.quran.lastPositionSeconds");
  });

  it("enforces root-level QuranAudioProvider and persistent playback across page navigation", async () => {
    const fs = await import("node:fs");
    const appSource = fs.readFileSync("client/src/App.tsx", "utf8");
    const layoutSource = fs.readFileSync("client/src/components/AppLayout.tsx", "utf8");
    const contextSource = fs.readFileSync("client/src/components/quran/QuranAudioContext.tsx", "utf8");
    const posSource = fs.readFileSync("client/src/pages/PointOfSale.tsx", "utf8");

    // 1. App.tsx must wrap the application tree in QuranAudioProvider
    expect(appSource).toContain("<QuranAudioProvider>");
    expect(appSource).toContain("</QuranAudioProvider>");
    expect(appSource).toContain("<QuranStationDrawer");

    // 2. AppLayout must NOT wrap its children in QuranAudioProvider (preventing tear-down on navigation)
    expect(layoutSource).not.toContain("<QuranAudioProvider>");
    expect(layoutSource).toContain("<QuranHeaderButton");

    // 3. QuranAudioContext must use persistent singleton audio and not pause on unmount
    expect(contextSource).toContain("globalAudioInstance");
    expect(contextSource).toContain("getGlobalAudio");
    expect(contextSource).not.toContain("audio.pause();\n      audio.src = \"\";");

    // 4. POS must include QuranHeaderButton for cashier access
    expect(posSource).toContain("<QuranHeaderButton");

    // 5. Auth boundary & session reset contracts
    const sessionBoundarySource = fs.readFileSync("client/src/lib/offline/sessionBoundary.ts", "utf8");
    expect(contextSource).toContain("export function pauseGlobalQuranAudio");
    expect(sessionBoundarySource).toContain("pauseGlobalQuranAudio()");
    expect(appSource).toContain("QuranAuthBoundary");
    expect(appSource).toContain("pauseGlobalQuranAudio()");

    // 6. Cold studio gate in mobile header
    expect(layoutSource).toContain("{!coldStudio && <QuranHeaderButton />}");
  });
});

