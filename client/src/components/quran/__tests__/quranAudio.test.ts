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
});
