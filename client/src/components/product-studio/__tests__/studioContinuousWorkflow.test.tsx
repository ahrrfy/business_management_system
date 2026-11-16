// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  StudioProductCardStatus,
  deriveProductStudioStatus,
  type StudioProductDetails,
} from "../StudioProductCardStatus";
import {
  StudioCameraCapture,
  processCameraCaptureFile,
} from "../StudioCameraCapture";
import { StudioPreviewSubmitBar } from "../StudioPreviewSubmitBar";
import { StudioContinuousWorkflow } from "../StudioContinuousWorkflow";

// 1. Mocking sonner toasts
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// 2. Mocking tRPC
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      productStudio: { invalidate: vi.fn() },
      catalog: {
        adminList: { invalidate: vi.fn() },
        posList: { invalidate: vi.fn() },
      },
    }),
    productStudio: {
      quickBarcodeLookup: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      quickSaveBarcodeProductImage: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ success: true, message: "تم الحفظ" }),
          isPending: false,
        }),
      },
      quickAiTransform: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockImplementation(async (input: any) => ({
            imageDataUrl: input.imageDataUrl,
            provider: "GEMINI",
            model: "gemini-2.5-flash",
            fallbackApplied: false,
          })),
          isPending: false,
        }),
      },
    },
  },
}));

// 3. Mocking CameraScanner
vi.mock("@/components/scan/CameraScanner", () => ({
  CameraScanner: ({ open, onClose, onDetect }: any) =>
    open ? (
      <div data-testid="mock-camera-scanner">
        <button
          type="button"
          data-testid="mock-scanner-detect-btn"
          onClick={() => onDetect("6931234567890")}
        >
          كشف باركود
        </button>
        <button type="button" onClick={onClose}>
          إغلاق
        </button>
      </div>
    ) : null,
}));

// 4. Mocking createProductDisplayThumbnail
vi.mock("@/lib/productImageThumbnail", () => ({
  createProductDisplayThumbnail: vi.fn().mockImplementation(async (url: string) => url),
}));

// 5. Mocking UnifiedSearchInput
vi.mock("@/components/search/UnifiedSearchInput", () => ({
  UnifiedSearchInput: React.forwardRef(
    ({ value, onChange, onScan, onSubmit, placeholder, disabled }: any, ref: any) => (
      <input
        ref={ref}
        type="text"
        data-testid="mock-unified-search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit?.();
        }}
        placeholder={placeholder}
        disabled={disabled}
      />
    ),
  ),
}));

// إعداد بيئة React 19 للـ act
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioContinuousWorkflow & Components Test Suite", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();

    // محاكاة createImageBitmap و Canvas لدعم بيئة jsdom فائقة السرعة
    vi.stubGlobal("createImageBitmap", vi.fn().mockImplementation(async () => ({
      width: 800,
      height: 600,
      close: vi.fn(),
    })));

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    }) as any;

    HTMLCanvasElement.prototype.toBlob = function (cb: any, type: string) {
      cb(new Blob(["dummy blob content"], { type: type || "image/jpeg" }));
    } as any;

    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue(
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    );

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const sampleProduct: StudioProductDetails = {
    id: 101,
    name: "دفتر سلك جامعي 100 ورقة",
    brand: "الرؤية",
    modelName: "سلك-100",
    categoryName: "قرطاسية",
    variantId: 202,
    variantName: "أزرق",
    unitId: 303,
    unitName: "قطعة",
    barcode: "6931234567890",
    isActive: true,
  };

  // =========================================================================
  // 1. اختبارات شارات الحالة الثلاث في StudioProductCardStatus
  // =========================================================================
  describe("StudioProductCardStatus — 3 Dynamic Status Badges", () => {
    it("renders «مصور مسبقاً» badge with thumbnails, cover star, and add/replace action buttons", async () => {
      const images = [
        {
          id: 1,
          url: "https://example.com/cover.jpg",
          thumbDataUrl: "data:image/jpeg;base64,thumb1",
          isPrimary: true,
          sortOrder: 0,
        },
        {
          id: 2,
          url: "https://example.com/side.jpg",
          thumbDataUrl: "data:image/jpeg;base64,thumb2",
          isPrimary: false,
          sortOrder: 1,
        },
      ];

      const onSelectAction = vi.fn();
      const onStartCapture = vi.fn();

      await act(async () => {
        root.render(
          <StudioProductCardStatus
            product={sampleProduct}
            images={images}
            onSelectAction={onSelectAction}
            onStartCapture={onStartCapture}
          />,
        );
      });

      // التحقق من اسم المنتج
      expect(host.querySelector('[data-testid="product-card-name"]')?.textContent).toContain(
        "دفتر سلك جامعي 100 ورقة",
      );

      // التحقق من الشارة «مصور مسبقاً»
      const badge = host.querySelector('[data-testid="status-badge-previously-photographed"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain("مصور مسبقاً");

      // التحقق من شريط المصغرات
      const strip = host.querySelector('[data-testid="previous-photos-strip"]');
      expect(strip).not.toBeNull();
      expect(strip?.querySelectorAll("img").length).toBe(2);

      // التحقق من مؤشر صورة الغلاف الرئيسية
      const coverStar = host.querySelector('[data-testid="primary-cover-indicator"]');
      expect(coverStar).not.toBeNull();

      // التحقق من زري «إضافة صورة إضافية» و«استبدال الصورة الحالية»
      const addBtn = host.querySelector('[data-testid="btn-add-additional-photo"]') as HTMLButtonElement;
      const replaceBtn = host.querySelector('[data-testid="btn-replace-current-photo"]') as HTMLButtonElement;
      expect(addBtn).not.toBeNull();
      expect(replaceBtn).not.toBeNull();
      expect(addBtn.textContent).toContain("إضافة صورة إضافية");
      expect(replaceBtn.textContent).toContain("استبدال الصورة الحالية");

      // النقر على إضافة صورة إضافية
      await act(async () => {
        addBtn.click();
      });
      expect(onSelectAction).toHaveBeenCalledWith("ADD");
      expect(onStartCapture).toHaveBeenCalled();

      // النقر على استبدال الصورة الحالية
      await act(async () => {
        replaceBtn.click();
      });
      expect(onSelectAction).toHaveBeenCalledWith("REPLACE");
    });

    it("renders «بانتظار الاعتماد» badge with pending review thumbnail and reshoot option", async () => {
      const activeJob = {
        id: 55,
        status: "PENDING_REVIEW",
        candidateThumb: "data:image/jpeg;base64,pendingThumb",
      };
      const onStartCapture = vi.fn();

      await act(async () => {
        root.render(
          <StudioProductCardStatus
            product={sampleProduct}
            images={[]}
            activeJob={activeJob}
            onStartCapture={onStartCapture}
          />,
        );
      });

      // التحقق من الشارة «بانتظار الاعتماد»
      const badge = host.querySelector('[data-testid="status-badge-pending-review"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain("بانتظار الاعتماد");

      // التحقق من تفاصيل الانتظار
      const details = host.querySelector('[data-testid="pending-review-details"]');
      expect(details).not.toBeNull();
      expect(details?.textContent).toContain("توجد لقطة جديدة مرفوعة بانتظار موافقة الإدارة");

      // التحقق من زر إضافة صورة أخرى للمنتج
      const reshootBtn = host.querySelector('[data-testid="btn-reshoot-pending"]') as HTMLButtonElement;
      expect(reshootBtn).not.toBeNull();
      expect(reshootBtn.textContent).toContain("إضافة صورة أخرى للمنتج");

      await act(async () => {
        reshootBtn.click();
      });
      expect(onStartCapture).toHaveBeenCalled();
    });

    it("renders «بلا صورة» badge with prominent shoot button", async () => {
      const onStartCapture = vi.fn();

      await act(async () => {
        root.render(
          <StudioProductCardStatus
            product={sampleProduct}
            images={[]}
            activeJob={null}
            onStartCapture={onStartCapture}
          />,
        );
      });

      // التحقق من الشارة «بلا صورة»
      const badge = host.querySelector('[data-testid="status-badge-no-image"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain("بلا صورة");

      // التحقق من زر التقاط صورة المنتج الآن
      const shootBtn = host.querySelector('[data-testid="btn-shoot-now"]') as HTMLButtonElement;
      expect(shootBtn).not.toBeNull();
      expect(shootBtn.textContent).toContain("التقاط صورة المنتج الآن");
      expect(shootBtn.className).toContain("min-h-12");

      await act(async () => {
        shootBtn.click();
      });
      expect(onStartCapture).toHaveBeenCalled();
    });

    it("helper function deriveProductStudioStatus correctly maps image/job states", () => {
      expect(deriveProductStudioStatus([], { id: 1, status: "PENDING_REVIEW" })).toBe("PENDING_REVIEW");
      expect(deriveProductStudioStatus([{ id: 1, url: "test.jpg" }], null)).toBe("PREVIOUSLY_PHOTOGRAPHED");
      expect(deriveProductStudioStatus([], null)).toBe("NO_IMAGE");
    });
  });

  // =========================================================================
  // 2. اختبار راية القفل التزامني المؤقت
  // =========================================================================
  describe("StudioProductCardStatus — Ephemeral Lock Warning Banner", () => {
    it("displays warning banner with photographer name and remaining seconds when locked by another user", async () => {
      const lock = {
        isLocked: true,
        activePhotographerName: "علي الكرخي",
        remainingSeconds: 45,
      };

      await act(async () => {
        root.render(
          <StudioProductCardStatus
            product={sampleProduct}
            lock={lock}
          />,
        );
      });

      const banner = host.querySelector('[data-testid="studio-lock-warning-banner"]');
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain("المنتج قيد التصوير حالياً بواسطة: علي الكرخي");
      expect(banner?.textContent).toContain("45 ثانية");
    });

    it("does not display lock banner when isLocked is false", async () => {
      const lock = {
        isLocked: false,
      };

      await act(async () => {
        root.render(
          <StudioProductCardStatus
            product={sampleProduct}
            lock={lock}
          />,
        );
      });

      const banner = host.querySelector('[data-testid="studio-lock-warning-banner"]');
      expect(banner).toBeNull();
    });
  });

  // =========================================================================
  // 3. اختبار رسالة الباركود غير المسجل بالنظام باللهجة المحلية
  // =========================================================================
  describe("StudioProductCardStatus — Unregistered Barcode Iraqi Feedback", () => {
    it("displays prominent Iraqi message «هذا الباركود غير مسجل بالنظام» when isUnregistered is true", async () => {
      const onManualSearch = vi.fn();

      await act(async () => {
        root.render(
          <StudioProductCardStatus
            product={null}
            barcode="999888777"
            isUnregistered={true}
            onManualSearch={onManualSearch}
          />,
        );
      });

      const card = host.querySelector('[data-testid="studio-unregistered-barcode-card"]');
      expect(card).not.toBeNull();

      const feedback = host.querySelector('[data-testid="unregistered-barcode-feedback"]');
      expect(feedback).not.toBeNull();
      expect(feedback?.textContent).toContain("هذا الباركود غير مسجل بالنظام");
      expect(card?.textContent).toContain("999888777");

      // التحقق من زر البحث اليدوي
      const manualBtn = card?.querySelector("button");
      expect(manualBtn?.textContent).toContain("البحث اليدوي عن المنتج");
      await act(async () => {
        manualBtn?.click();
      });
      expect(onManualSearch).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. اختبار StudioCameraCapture ومحاكاة المعالجة والتصوير
  // =========================================================================
  describe("StudioCameraCapture Component", () => {
    it("renders camera environment and gallery file inputs with large touch buttons", async () => {
      const onImageCaptured = vi.fn();

      await act(async () => {
        root.render(<StudioCameraCapture onImageCaptured={onImageCaptured} />);
      });

      const cameraInput = host.querySelector('[data-testid="camera-environment-input"]') as HTMLInputElement;
      const galleryInput = host.querySelector('[data-testid="file-gallery-input"]') as HTMLInputElement;
      expect(cameraInput).not.toBeNull();
      expect(galleryInput).not.toBeNull();

      expect(cameraInput.getAttribute("capture")).toBe("environment");
      expect(cameraInput.getAttribute("accept")).toBe("image/*");

      const openCamBtn = host.querySelector('[data-testid="btn-open-camera-back"]') as HTMLButtonElement;
      const galleryBtn = host.querySelector('[data-testid="btn-choose-from-gallery"]') as HTMLButtonElement;
      expect(openCamBtn).not.toBeNull();
      expect(galleryBtn).not.toBeNull();

      // التحقق من نصوص الأزرار البارزة المعتمدة
      expect(openCamBtn.textContent).toContain("التقاط بالكاميرا");
      expect(galleryBtn.textContent).toContain("رفع من الجهاز");

      // فحص سهولة الإبهام (min-h-12)
      expect(openCamBtn.className).toContain("min-h-12");
      expect(galleryBtn.className).toContain("min-h-12");
    });

    it("processCameraCaptureFile handles file processing and step notifications", async () => {
      const dummyFile = new File(["dummy image content"], "photo.jpg", {
        type: "image/jpeg",
      });

      const steps: string[] = [];
      const result = await processCameraCaptureFile(dummyFile, (step) => {
        steps.push(step);
      });

      expect(steps).toContain("reading");
      expect(steps).toContain("orienting");
      expect(steps).toContain("compressing");
      expect(steps).toContain("ready");
      expect(result.processedDataUrl).toBeTruthy();
      expect(result.sizeKB).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 5. اختبار StudioPreviewSubmitBar وإعادة التصوير ومنع التكرار (Debouncing) ورسائل الفخر
  // =========================================================================
  describe("StudioPreviewSubmitBar — Retake, 1-Click Submit & Iraqi Praise", () => {
    it("renders preview image, retake button, and triggers 1-click submit with debouncing", async () => {
      const onRetake = vi.fn();
      let resolveSubmit: () => void = () => {};
      const submitPromise = new Promise<void>((res) => {
        resolveSubmit = res;
      });
      const onSubmit = vi.fn().mockReturnValue(submitPromise);

      await act(async () => {
        root.render(
          <StudioPreviewSubmitBar
            previewUrl="data:image/jpeg;base64,samplePreview"
            sizeKB={240}
            onRetake={onRetake}
            onSubmit={onSubmit}
            canAutoApprove={false}
          />,
        );
      });

      // التحقق من عرض صورة المعاينة والحجم
      const previewImg = host.querySelector('[data-testid="preview-captured-image"]') as HTMLImageElement;
      expect(previewImg).not.toBeNull();
      expect(previewImg.src).toContain("samplePreview");
      expect(host.textContent).toContain("240 ك.ب");

      // النقر على إعادة التصوير
      const retakeBtn = host.querySelector('[data-testid="btn-retake-photo"]') as HTMLButtonElement;
      expect(retakeBtn).not.toBeNull();
      expect(retakeBtn.textContent).toContain("إعادة التصوير");
      expect(retakeBtn.className).toContain("min-h-12");

      await act(async () => {
        retakeBtn.click();
      });
      expect(onRetake).toHaveBeenCalledTimes(1);

      // فحص زر الإرسال بنقرة واحدة ومنع النقر المزدوج (Client Debounce via savingRef)
      const submitBtn = host.querySelector('[data-testid="btn-submit-photo-one-click"]') as HTMLButtonElement;
      expect(submitBtn).not.toBeNull();
      expect(submitBtn.className).toContain("min-h-12");

      // النقر السريع مرتين متتاليتين
      await act(async () => {
        submitBtn.click();
        submitBtn.click();
      });

      // يجب استدعاء onSubmit مرة واحدة فقط بسبب savingRef
      expect(onSubmit).toHaveBeenCalledTimes(1);

      // اكتمال الحفظ والتأكد من إطلاق توست الفخر العراقي «عاشت إيدك!»
      await act(async () => {
        resolveSubmit();
      });

      expect(toast.success).toHaveBeenCalledWith(
        "عاشت إيدك!",
        expect.objectContaining({
          description: expect.stringContaining("تم إرسال الصورة بنجاح"),
        }),
      );
    });

    it("displays direct publish label when canAutoApprove is true", async () => {
      await act(async () => {
        root.render(
          <StudioPreviewSubmitBar
            previewUrl="data:image/jpeg;base64,samplePreview"
            onRetake={vi.fn()}
            onSubmit={vi.fn()}
            canAutoApprove={true}
          />,
        );
      });

      const submitBtn = host.querySelector('[data-testid="btn-submit-photo-one-click"]');
      expect(submitBtn?.textContent).toContain("اعتماد ونشر الصورة فوراً");
    });

    it("renders 1-click toggle buttons between AI studio enhancement and original photo", async () => {
      const onToggle = vi.fn();
      await act(async () => {
        root.render(
          <StudioPreviewSubmitBar
            previewUrl="data:image/jpeg;base64,samplePreview"
            previewMode="AI"
            onTogglePreviewMode={onToggle}
            onRetake={vi.fn()}
            onSubmit={vi.fn()}
          />,
        );
      });

      const toggleGroup = host.querySelector('[data-testid="preview-mode-toggle-group"]');
      expect(toggleGroup).not.toBeNull();

      const aiBtn = host.querySelector('[data-testid="toggle-preview-ai"]') as HTMLButtonElement;
      const origBtn = host.querySelector('[data-testid="toggle-preview-original"]') as HTMLButtonElement;
      expect(aiBtn).not.toBeNull();
      expect(origBtn).not.toBeNull();
      expect(aiBtn.textContent).toContain("تحسين بالذكاء الاصطناعي");
      expect(origBtn.textContent).toContain("بدون معالجة (الأصلية)");

      await act(async () => {
        origBtn.click();
      });
      expect(onToggle).toHaveBeenCalledWith("ORIGINAL");
    });

    it("displays sleek loading overlay when isAiEnhancing is true and disables submit", async () => {
      await act(async () => {
        root.render(
          <StudioPreviewSubmitBar
            previewUrl="data:image/jpeg;base64,samplePreview"
            isAiEnhancing={true}
            onRetake={vi.fn()}
            onSubmit={vi.fn()}
          />,
        );
      });

      const indicator = host.querySelector('[data-testid="ai-enhancing-loading-indicator"]');
      expect(indicator).not.toBeNull();
      expect(indicator?.textContent).toContain("جاري المعالجة بذكاء الاستوديو...");

      const submitBtn = host.querySelector('[data-testid="btn-submit-photo-one-click"]') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);
      expect(submitBtn.textContent).toContain("جاري المعالجة بذكاء الاستوديو...");
    });

    it("displays safe fallback badge when fallbackApplied is true in AI preview", async () => {
      await act(async () => {
        root.render(
          <StudioPreviewSubmitBar
            previewUrl="data:image/jpeg;base64,samplePreview"
            previewMode="AI"
            fallbackApplied={true}
            isAiEnhancing={false}
            onRetake={vi.fn()}
            onSubmit={vi.fn()}
          />,
        );
      });

      const fallbackBadge = host.querySelector('[data-testid="ai-fallback-badge"]');
      expect(fallbackBadge).not.toBeNull();
      expect(fallbackBadge?.textContent).toContain("تم تفعيل المعالجة المحلية السريعة");
    });
  });

  // =========================================================================
  // 6. اختبار تدفق الخطوات الثلاث المتصل المتكامل (StudioContinuousWorkflow)
  // =========================================================================
  describe("StudioContinuousWorkflow — Full 3-Step Continuous Integration", () => {
    it("navigates cleanly through Step 1 (Scan) -> Step 2 (Capture) -> Step 3 (Preview) on a single screen", async () => {
      const mockSave = vi.fn().mockResolvedValue({ success: true });
      const onHandled = vi.fn();

      await act(async () => {
        root.render(
          <StudioContinuousWorkflow
            mockLookupData={{
              product: sampleProduct,
              images: [],
              activeJob: null,
              lock: null,
              canAutoApprove: true,
            }}
            mockOnSave={mockSave}
            onProductHandled={onHandled}
          />,
        );
      });

      // التحقق من مؤشر الخطوات
      const stepIndicator = host.querySelector('[data-testid="workflow-step-indicator"]');
      expect(stepIndicator).not.toBeNull();
      expect(stepIndicator?.textContent).toContain("مسح المنتج");
      expect(stepIndicator?.textContent).toContain("التقاط الكاميرا");
      expect(stepIndicator?.textContent).toContain("معاينة وإرسال");

      // نحن في الخطوة 1: عرض بطاقة المنتج وشارة «بلا صورة»
      expect(host.querySelector('[data-testid="workflow-step-scan"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="status-badge-no-image"]')).not.toBeNull();

      // النقر على زر «التقاط صورة المنتج الآن» للانتقال إلى الخطوة 2
      const shootBtn = host.querySelector('[data-testid="btn-shoot-now"]') as HTMLButtonElement;
      await act(async () => {
        shootBtn.click();
      });

      // تأكيد الانتقال إلى الخطوة 2 (Capture) في نفس الشاشة
      expect(host.querySelector('[data-testid="workflow-step-capture"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="studio-camera-capture"]')).not.toBeNull();

      // محاكاة التقاط الصورة
      const dummyFile = new File(["photo data"], "camera.jpg", { type: "image/jpeg" });
      const cameraInput = host.querySelector('[data-testid="camera-environment-input"]') as HTMLInputElement;

      await act(async () => {
        Object.defineProperty(cameraInput, "files", {
          value: [dummyFile],
          writable: true,
        });
        cameraInput.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      });

      // تأكيد الانتقال إلى الخطوة 3 (Preview)
      expect(host.querySelector('[data-testid="workflow-step-preview"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="studio-preview-submit-bar"]')).not.toBeNull();

      // اختبار زر إعادة التصوير من المعاينة (الرجوع للخطوة 2)
      const retakeBtn = host.querySelector('[data-testid="btn-retake-photo"]') as HTMLButtonElement;
      await act(async () => {
        retakeBtn.click();
      });

      expect(host.querySelector('[data-testid="workflow-step-capture"]')).not.toBeNull();

      // التقاط الصورة مجدداً للعودة للمعاينة
      await act(async () => {
        const input2 = host.querySelector('[data-testid="camera-environment-input"]') as HTMLInputElement;
        Object.defineProperty(input2, "files", {
          value: [dummyFile],
          writable: true,
        });
        input2.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(host.querySelector('[data-testid="workflow-step-preview"]')).not.toBeNull();

      // إرسال الصورة بنقرة واحدة
      const submitBtn = host.querySelector('[data-testid="btn-submit-photo-one-click"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      // التأكد من استدعاء mockSave بالمعاملات الصحيحة مع نمط AI التلقائي
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 101,
          mode: "AI",
          setAsPrimary: true,
        }),
      );

      // التأكد من استدعاء onProductHandled
      expect(onHandled).toHaveBeenCalledWith(101);

      // بعد النجاح: العودة إلى الخطوة 1 مع راية الفخر لمسح المنتج التالي مباشرة
      expect(host.querySelector('[data-testid="workflow-step-scan"]')).not.toBeNull();
      const successBanner = host.querySelector('[data-testid="studio-success-banner"]');
      expect(successBanner).not.toBeNull();
      expect(successBanner?.textContent).toContain("عاشت إيدك!");
    });

    it("automatically invokes AI studio transform upon capture and submits enhanced image with mode AI", async () => {
      const mockAiTransform = vi.fn().mockImplementation(async (input: any) => ({
        imageDataUrl: "data:image/jpeg;base64,enhancedStudioImage123",
        sizeKB: 195,
        provider: "GEMINI",
        fallbackApplied: false,
      }));
      const mockSave = vi.fn().mockResolvedValue({ success: true });

      await act(async () => {
        root.render(
          <StudioContinuousWorkflow
            mockLookupData={{
              product: sampleProduct,
              images: [],
              activeJob: null,
              lock: null,
              canAutoApprove: false,
            }}
            mockOnAiTransform={mockAiTransform}
            mockOnSave={mockSave}
          />,
        );
      });

      // 1. الانتقال للتصوير
      const shootBtn = host.querySelector('[data-testid="btn-shoot-now"]') as HTMLButtonElement;
      await act(async () => {
        shootBtn.click();
      });

      // 2. محاكاة التقاط الصورة بالكاميرا
      const dummyFile = new File(["photo data"], "camera.jpg", { type: "image/jpeg" });
      const cameraInput = host.querySelector('[data-testid="camera-environment-input"]') as HTMLInputElement;

      await act(async () => {
        Object.defineProperty(cameraInput, "files", {
          value: [dummyFile],
          writable: true,
        });
        cameraInput.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      });

      // التأكد من الاستدعاء التلقائي لمعالجة الذكاء الاصطناعي فور الالتقاط
      expect(mockAiTransform).toHaveBeenCalledTimes(1);
      expect(mockAiTransform).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "AI",
          productId: 101,
          barcode: "6931234567890",
          imageDataUrl: expect.stringContaining("data:image/"),
        }),
      );

      // 3. التحقق من عرض النتيجة المحسنة بالذكاء في المعاينة
      const previewImg = host.querySelector('[data-testid="preview-captured-image"]') as HTMLImageElement;
      expect(previewImg).not.toBeNull();
      expect(previewImg.src).toContain("enhancedStudioImage123");

      // 4. إرسال الصورة بنقرة واحدة والتأكد من إرسال mode: "AI"
      const submitBtn = host.querySelector('[data-testid="btn-submit-photo-one-click"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 101,
          mode: "AI",
          processedDataUrl: "data:image/jpeg;base64,enhancedStudioImage123",
        }),
      );
    });

    it("allows employee to toggle between «تحسين بالذكاء الاصطناعي» and «بدون معالجة (الأصلية)» and submits selected mode", async () => {
      const mockAiTransform = vi.fn().mockImplementation(async (input: any) => ({
        imageDataUrl: "data:image/jpeg;base64,enhancedStudioImage999",
        sizeKB: 210,
        provider: "GEMINI",
        fallbackApplied: false,
      }));
      const mockSave = vi.fn().mockResolvedValue({ success: true });

      await act(async () => {
        root.render(
          <StudioContinuousWorkflow
            mockLookupData={{
              product: sampleProduct,
              images: [],
              activeJob: null,
              lock: null,
              canAutoApprove: true,
            }}
            mockOnAiTransform={mockAiTransform}
            mockOnSave={mockSave}
          />,
        );
      });

      // الانتقال للتصوير
      const shootBtn = host.querySelector('[data-testid="btn-shoot-now"]') as HTMLButtonElement;
      await act(async () => {
        shootBtn.click();
      });

      // التقاط الصورة
      const dummyFile = new File(["raw photo content"], "camera.jpg", { type: "image/jpeg" });
      const cameraInput = host.querySelector('[data-testid="camera-environment-input"]') as HTMLInputElement;

      await act(async () => {
        Object.defineProperty(cameraInput, "files", {
          value: [dummyFile],
          writable: true,
        });
        cameraInput.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      });

      // التبديل بضغطة واحدة إلى «بدون معالجة (الأصلية)»
      const origToggleBtn = host.querySelector('[data-testid="toggle-preview-original"]') as HTMLButtonElement;
      expect(origToggleBtn).not.toBeNull();
      await act(async () => {
        origToggleBtn.click();
      });

      // في وضع الأصلية، لا تظهر الصورة المحسنة بل الأصلية المضغوطة
      const previewImg = host.querySelector('[data-testid="preview-captured-image"]') as HTMLImageElement;
      expect(previewImg.src).not.toContain("enhancedStudioImage999");

      // إرسال الصورة بنقرة واحدة
      const submitBtn = host.querySelector('[data-testid="btn-submit-photo-one-click"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      // التأكد من حفظ وضع FLATTEN الأصلي
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 101,
          mode: "FLATTEN",
        }),
      );
    });

    it("gracefully falls back to local processing when AI service fails or times out without blocking the employee", async () => {
      const mockFailingAi = vi.fn().mockRejectedValue(new Error("AI Provider Gateway Timeout (504)"));
      const mockSave = vi.fn().mockResolvedValue({ success: true });

      await act(async () => {
        root.render(
          <StudioContinuousWorkflow
            mockLookupData={{
              product: sampleProduct,
              images: [],
              activeJob: null,
              lock: null,
              canAutoApprove: true,
            }}
            mockOnAiTransform={mockFailingAi}
            mockOnSave={mockSave}
          />,
        );
      });

      // الانتقال للتصوير
      const shootBtn = host.querySelector('[data-testid="btn-shoot-now"]') as HTMLButtonElement;
      await act(async () => {
        shootBtn.click();
      });

      // التقاط الصورة
      const dummyFile = new File(["raw photo"], "camera.jpg", { type: "image/jpeg" });
      const cameraInput = host.querySelector('[data-testid="camera-environment-input"]') as HTMLInputElement;

      await act(async () => {
        Object.defineProperty(cameraInput, "files", {
          value: [dummyFile],
          writable: true,
        });
        cameraInput.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      });

      // التأكد من استدعاء الذكاء الاصطناعي وحدوث الفشل
      expect(mockFailingAi).toHaveBeenCalled();

      // التحقق من أن المسار لم يتعطل ولا زال في شاشة المعاينة
      expect(host.querySelector('[data-testid="workflow-step-preview"]')).not.toBeNull();
      // ظهور راية البديل المحلي الآمن
      expect(host.querySelector('[data-testid="ai-fallback-badge"]')).not.toBeNull();

      // تمكين الموظف من إرسال الصورة بنجاح دون أي حظر أو توقف
      const submitBtn = host.querySelector('[data-testid="btn-submit-photo-one-click"]') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(false);

      await act(async () => {
        submitBtn.click();
      });

      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 101,
          mode: "AI",
        }),
      );
    });

    it("displays unregistered barcode warning when barcode is not in catalog", async () => {
      await act(async () => {
        root.render(
          <StudioContinuousWorkflow
            initialBarcode="111222333"
            mockLookupData={{
              product: null,
              isUnregistered: true,
            }}
          />,
        );
      });

      const unregisteredFeedback = host.querySelector('[data-testid="unregistered-barcode-feedback"]');
      expect(unregisteredFeedback).not.toBeNull();
      expect(unregisteredFeedback?.textContent).toContain("هذا الباركود غير مسجل بالنظام");
    });
  });

  // =========================================================================
  // 7. اختبار التجاوب وبيئة العرض (Responsive Layout & Viewport Verification)
  // =========================================================================
  describe("Viewport Responsiveness & Thumb Ergonomics", () => {
    it("applies responsive layout classes and thumb-friendly touch targets on mobile & desktop", async () => {
      await act(async () => {
        root.render(
          <StudioContinuousWorkflow
            mockLookupData={{
              product: sampleProduct,
              images: [],
              activeJob: null,
              lock: null,
            }}
          />,
        );
      });

      // فحص الحاوية الرئيسية المتجاوبة
      const workflowContainer = host.querySelector('[data-testid="studio-continuous-workflow"]');
      expect(workflowContainer).not.toBeNull();
      expect(workflowContainer?.className).toContain("w-full");
      expect(workflowContainer?.className).toContain("max-w-xl");
      expect(workflowContainer?.className).toContain("mx-auto");

      // فحص اتجاه RTL
      expect(workflowContainer?.getAttribute("dir")).toBe("rtl");

      // فحص بطاقة المنتج المتجاوبة
      const card = host.querySelector('[data-testid="studio-product-card-status"]');
      expect(card).not.toBeNull();
      expect(card?.className).toContain("w-full");
      expect(card?.className).toContain("max-w-xl");
    });
  });
});
