import { describe, it, expect } from "vitest";
import {
  calculateProductRelevance,
  isQualifiedBundle,
  hasWordToken,
  hasPhrase,
  extractWordTokens,
  normalizeThematicText,
  THEMATIC_ARCHETYPES,
} from "../storefrontThematicService";

describe("storefrontThematicService — محرك المطابقة الرمزية والتراكيب الذكية", () => {
  const calligraphyArch = THEMATIC_ARCHETYPES.find((a) => a.id === "calligraphy")!;
  const dealsArch = THEMATIC_ARCHETYPES.find((a) => a.id === "deals")!;
  const executiveArch = THEMATIC_ARCHETYPES.find((a) => a.id === "executive")!;
  const academicArch = THEMATIC_ARCHETYPES.find((a) => a.id === "academic")!;

  describe("١. حدود الكلمات الصارمة (Word Boundary Matching)", () => {
    it("لا تطابق «باك» كلمة «باكيت» ولا «شباك» ولا «باكستان»", () => {
      const tokens1 = extractWordTokens(normalizeThematicText("باكيت لعبة اونو"));
      expect(hasWordToken(tokens1, "باك")).toBe(false);
      expect(hasPhrase("باكيت لعبة اونو", "باك")).toBe(false);

      const tokens2 = extractWordTokens(normalizeThematicText("باكيت هايلايت 4 لون"));
      expect(hasWordToken(tokens2, "باك")).toBe(false);
      expect(hasPhrase("باكيت هايلايت 4 لون", "باك")).toBe(false);

      const tokens3 = extractWordTokens(normalizeThematicText("باك دفاتر سلك جامعية"));
      expect(hasWordToken(tokens3, "باك")).toBe(true);
      expect(hasPhrase("باك دفاتر سلك جامعية", "باك")).toBe(true);
    });

    it("لا تطابق «بخ» الكلمات المشتقة مثل «مطبخ» أو «بخور»", () => {
      expect(hasPhrase("مطبخ عصري أنيق", "بخ")).toBe(false);
      expect(hasPhrase("بخور ملكي فاخر", "بخ")).toBe(false);
    });

    it("تطابق التراكيب متعددة الكلمات بحدود دقيقة (N-grams)", () => {
      expect(hasPhrase("قلم حبر جاف باركر جوتر", "قلم حبر")).toBe(true);
      expect(hasPhrase("سيت باركر مع محبرة", "حبر خط")).toBe(false);
      expect(hasPhrase("طقم تحبير هندسي روترينغ", "تحبير هندسي")).toBe(true);
    });
  });

  describe("٢. معالجة خلل الباكيت والألعاب في كرت البكجات (Deals / Bundles)", () => {
    it("تستبعد تماماً ألعاب الأطفال والتسلية والورق من كرت البكجات (-100)", () => {
      const unoPacket = {
        productName: "باكيت لعبة اونو ALFA 12K\\A SPIn",
        category: "تجهيزات الالعاب",
        unitName: "قطعة",
        price: "3500",
        salePrice: "2500", // حتى لو كان عليه تخفيض
      };
      expect(isQualifiedBundle(unoPacket)).toBe(false);
      expect(calculateProductRelevance(unoPacket, dealsArch)).toBe(-100);

      const pokerPacket = {
        productName: "لعبة ورق باكيت POKER 100732",
        category: "تجهيزات الالعاب",
        unitName: "قطعة",
      };
      expect(isQualifiedBundle(pokerPacket)).toBe(false);
      expect(calculateProductRelevance(pokerPacket, dealsArch)).toBe(-100);

      const puzzlePacket = {
        productName: "لعبة بزل 1000 قطعة باكيت",
        category: "العاب الذكاء",
        unitName: "قطعة",
      };
      expect(isQualifiedBundle(puzzlePacket)).toBe(false);
      expect(calculateProductRelevance(puzzlePacket, dealsArch)).toBe(-100);
    });

    it("تستبعد عبوات التجزئة الفردية ووحدة «باكيت» و«درزن» من كرت البكجات (-100)", () => {
      const highlightPacket = {
        productName: "باكيت هايلايت 4 لون CHOSCH H954",
        category: "اقلام التأشير (هايلايت)",
        unitName: "قطعة",
        price: "4000",
        salePrice: "3000",
      };
      expect(isQualifiedBundle(highlightPacket)).toBe(false);
      expect(calculateProductRelevance(highlightPacket, dealsArch)).toBe(-100);

      const penPacketUnit = {
        productName: "قلم جاف deli 0.1",
        category: "اقلام الجاف",
        unitName: "باكيت",
      };
      expect(isQualifiedBundle(penPacketUnit)).toBe(false);
      expect(calculateProductRelevance(penPacketUnit, dealsArch)).toBe(-100);

      const singleDozenPen = {
        productName: "قلم جاف أزرق كلاسيكي",
        category: "قرطاسية",
        unitName: "درزن",
      };
      expect(isQualifiedBundle(singleDozenPen)).toBe(false);
      expect(calculateProductRelevance(singleDozenPen, dealsArch)).toBe(-100);
    });

    it("تقبل وتمنح درجات مرتفعة للباقات والحزم الحقيقية", () => {
      const notebookPack = {
        productName: "باك دفاتر سلك جامعية 80 ورقة (مجموعة 5 دفاتر متنوعة)",
        category: "دفاتر ومذكرات",
        unitName: "باقة",
        price: "15000",
        salePrice: "12000",
      };
      expect(isQualifiedBundle(notebookPack)).toBe(true);
      const scoreNotebook = calculateProductRelevance(notebookPack, dealsArch);
      expect(scoreNotebook).toBeGreaterThanOrEqual(dealsArch.minRelevanceThreshold);

      const studentBundle = {
        productName: "بكج الطالب المتفوق المتكامل (حقيبة + دفاتر + مقلمة + طقم أقلام)",
        category: "بكجات وهدايا راقية",
        unitName: "بكج",
        price: "35000",
        salePrice: "29000",
      };
      expect(isQualifiedBundle(studentBundle)).toBe(true);
      const scoreStudent = calculateProductRelevance(studentBundle, dealsArch);
      expect(scoreStudent).toBeGreaterThanOrEqual(dealsArch.minRelevanceThreshold);
    });

    it("تستبعد بكجات وبخاخات تلوين الأطفال من كرت البكجات ومن كرت الفنون (-100)", () => {
      const kidsPanter = {
        productName: "بكج تلوين اطفال Panter KIDSPUW112",
        category: "مستلزمات وادوات الرسم والفن",
        unitName: "قطعة",
        price: "10000",
      };
      expect(isQualifiedBundle(kidsPanter)).toBe(false);
      expect(calculateProductRelevance(kidsPanter, dealsArch)).toBe(-100);
      const creativeArch = THEMATIC_ARCHETYPES.find((a) => a.id === "creative")!;
      expect(calculateProductRelevance(kidsPanter, creativeArch)).toBe(-100);

      const kidsSpray = {
        productName: "بخ تلوين اطفال PANTER PUW110",
        category: "مستلزمات وادوات الرسم والفن",
        unitName: "قطعة",
        price: "10000",
      };
      expect(isQualifiedBundle(kidsSpray)).toBe(false);
      expect(calculateProductRelevance(kidsSpray, dealsArch)).toBe(-100);
      expect(calculateProductRelevance(kidsSpray, creativeArch)).toBe(-100);
    });
  });

  describe("٣. معالجة خلل أحبار الطابعات والأختام في كرت الخط والحبر العربي (Calligraphy)", () => {
    it("تستبعد فورياً (-100) أحبار الطابعات وماكينات الطباعة ومستهلكاتها من الإنتاج", () => {
      const printerInk = {
        productName: "حبر طابعة جوكر(مناسب لجميع انواع طابعات ) J0J0 BUY 5GET1FREE",
        category: "التجهيزات الالكترونية والكهربائية",
      };
      expect(calculateProductRelevance(printerInk, calligraphyArch)).toBe(-100);

      const epsonInk = {
        productName: "حبر ايبسون VIVID V57.1",
        category: "التجهيزات الالكترونية والكهربائية",
      };
      expect(calculateProductRelevance(epsonInk, calligraphyArch)).toBe(-100);

      const epsonL8050 = {
        productName: "حبر ايبسون VIVID V18 L8050",
        category: "التجهيزات الالكترونية والكهربائية",
      };
      expect(calculateProductRelevance(epsonL8050, calligraphyArch)).toBe(-100);

      const ecoSolvent = {
        productName: "حبر ايكو سولفنت i3200",
        category: "المواد الخام",
      };
      expect(calculateProductRelevance(ecoSolvent, calligraphyArch)).toBe(-100);

      const uvInk = {
        productName: "حبر UV Flatbed",
        category: "المواد الخام",
      };
      expect(calculateProductRelevance(uvInk, calligraphyArch)).toBe(-100);

      const consumableBlackToner = {
        productName: "حبر/تونر أسود",
        category: "مستهلكات الطباعة",
      };
      expect(calculateProductRelevance(consumableBlackToner, calligraphyArch)).toBe(-100);
    });

    it("تستبعد فورياً (-100) أحبار الأختام والستمبات والسبورات والمساحات والتصحيح", () => {
      const colopStamp = {
        productName: "حبر ختم COLOP",
        category: "الاختام التجارية والشخصية والشركات",
      };
      expect(calculateProductRelevance(colopStamp, calligraphyArch)).toBe(-100);

      const horsePad = {
        productName: "حبر ستمبة HOrse",
        category: "تجهيزات مكتبية",
      };
      expect(calculateProductRelevance(horsePad, calligraphyArch)).toBe(-100);

      const magicStamp = {
        productName: "حبر سحري 804",
        category: "الاختام التجارية والشخصية والشركات",
      };
      expect(calculateProductRelevance(magicStamp, calligraphyArch)).toBe(-100);

      const whiteboardInk = {
        productName: "علبة حبر اقلام سبورة STAEDTLER 30ml",
        category: "السبورات بكافة احجامها وملحقاتها",
      };
      expect(calculateProductRelevance(whiteboardInk, calligraphyArch)).toBe(-100);

      const eraserInk = {
        productName: "مساحة حبر ستدلر (مساحة قلم جاف) STAEDTLER rasoplast combi",
        category: "مساحات",
      };
      expect(calculateProductRelevance(eraserInk, calligraphyArch)).toBe(-100);

      const correctionFluid = {
        productName: "فرشة حبر ابيض amigo correction Fluid",
        category: "تجهيزات مكتبية",
      };
      expect(calculateProductRelevance(correctionFluid, calligraphyArch)).toBe(-100);
    });

    it("تمرر وتمنح درجات امتياز لأدوات الخط وأقلام ومحابر الحبر الفاخرة", () => {
      const parkerInkwell = {
        productName: "سيت باركر مع محبرة",
        category: "اقلام الحبر",
      };
      const scoreParker = calculateProductRelevance(parkerInkwell, calligraphyArch);
      expect(scoreParker).toBeGreaterThanOrEqual(calligraphyArch.minRelevanceThreshold);

      const rotringSet = {
        productName: "طقم تحبير هندسي روترينغ رابيدوغراف 4 أقلام",
        category: "أقلام وأدوات كتابة",
      };
      const scoreRotring = calculateProductRelevance(rotringSet, calligraphyArch);
      expect(scoreRotring).toBeGreaterThanOrEqual(calligraphyArch.minRelevanceThreshold);

      const parkerPen = {
        productName: "قلم حبر جاف باركر جوتر كلاسيك ستانلس ستيل",
        category: "أقلام وأدوات كتابة",
      };
      const scoreParkerPen = calculateProductRelevance(parkerPen, calligraphyArch);
      expect(scoreParkerPen).toBeGreaterThanOrEqual(calligraphyArch.minRelevanceThreshold);

      const featherPenSet = {
        productName: "سيت قلم ريشة مع حبر (هاري بوتر) C-6246",
        category: "اقلام الحبر",
      };
      const scoreFeather = calculateProductRelevance(featherPenSet, calligraphyArch);
      expect(scoreFeather).toBeGreaterThanOrEqual(calligraphyArch.minRelevanceThreshold);

      const glassPen = {
        productName: "قلم حبر زجاجي مع الاحبار C-632",
        category: "اقلام الحبر",
      };
      const scoreGlass = calculateProductRelevance(glassPen, calligraphyArch);
      expect(scoreGlass).toBeGreaterThanOrEqual(calligraphyArch.minRelevanceThreshold);

      const technicalPen = {
        productName: "قلم تحبير 0.5 ستدلر STAEDLER",
        category: "التجهيزات الهندسية",
      };
      const scoreTech = calculateProductRelevance(technicalPen, calligraphyArch);
      expect(scoreTech).toBeGreaterThanOrEqual(calligraphyArch.minRelevanceThreshold);
    });
  });

  describe("٤. رفع عتبات الملاءمة الدلالية وحماية باقي الأنماط", () => {
    it("عتبة الخط لا تسمح بمرور كلمة واحدة هشة بلا سياق", () => {
      expect(calligraphyArch.minRelevanceThreshold).toBe(40);
      expect(dealsArch.minRelevanceThreshold).toBe(35);
      expect(executiveArch.minRelevanceThreshold).toBe(30);
      expect(academicArch.minRelevanceThreshold).toBe(30);
    });

    it("نمط المكاتب القيادية (Executive) يستبعد المستلزمات المدرسية والألعاب", () => {
      const schoolItem = {
        productName: "مقلمة مدرسية مع طقم أقلام تلوين",
        category: "حقائب ومقالم مدرسية",
      };
      expect(calculateProductRelevance(schoolItem, executiveArch)).toBe(-100);

      const luxuryItem = {
        productName: "طقم منظم مكتب معدني شبكي أسود 6 قطع متكامل",
        category: "تجهيزات ومستلزمات مكتبية",
      };
      const scoreLuxury = calculateProductRelevance(luxuryItem, executiveArch);
      expect(scoreLuxury).toBeGreaterThanOrEqual(executiveArch.minRelevanceThreshold);
    });

    it("تطبيع الأرقام المشرقية والإنجليزية واستبعاد المستبعدات بالأرقام (دفتر ٤٠ / دفتر 40)", () => {
      const notebookArabicDigits = {
        productName: "دفتر ٤٠ ورقة مدرسي",
        category: "قرطاسية",
      };
      expect(calculateProductRelevance(notebookArabicDigits, executiveArch)).toBe(-100);

      const notebookLatinDigits = {
        productName: "دفتر 40 ورقة مدرسي",
        category: "قرطاسية",
      };
      expect(calculateProductRelevance(notebookLatinDigits, executiveArch)).toBe(-100);
    });

    it("تطابق الكلمات المستبعدة بالإنجليزية بحروف كبيرة وصغيرة (EPSON / Brother / HP / JOKER)", () => {
      const upperEpson = {
        productName: "INK EPSON L8050 ORIGINAL",
        category: "ELECTRONICS",
      };
      expect(calculateProductRelevance(upperEpson, calligraphyArch)).toBe(-100);

      const upperCanon = {
        productName: "حبر CANON G3010 أصلي",
        category: "مستهلكات",
      };
      expect(calculateProductRelevance(upperCanon, calligraphyArch)).toBe(-100);

      const upperHp = {
        productName: "حبر طابعة HP 1100 LaserJet",
        category: "طابعات",
      };
      expect(calculateProductRelevance(upperHp, calligraphyArch)).toBe(-100);
    });
  });
});
