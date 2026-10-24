// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuickStudioController } from "@/components/product-studio/quick-lookup/useQuickStudioController";
import type { QuickStudioProps } from "@/components/product-studio/quick-lookup/types";
import {
  adjustStudioReviewZoom,
  defaultStudioScope,
  findScannedOwnedTask,
  mobileStudioPanel,
  toggleStudioReviewImage,
} from "./mobileStudioUi";

const quick = vi.hoisted(() => ({
  prepare: vi.fn(),
  flatten: vi.fn(),
  ai: vi.fn(),
  save: vi.fn(),
  thumbnail: vi.fn(),
  ok: vi.fn(),
  warn: vi.fn(),
  err: vi.fn(),
  invalidate: vi.fn(),
  refetch: vi.fn(),
  handled: vi.fn(),
  canSave: true,
  aiAvailable: false,
}));
vi.mock(
  "@/components/product-studio/quick-lookup/prepareMobileCapturedImage",
  () => ({ prepareMobileCapturedImage: quick.prepare }),
);
vi.mock("@/lib/productImageThumbnail", () => ({
  createProductDisplayThumbnail: quick.thumbnail,
}));
vi.mock("@/lib/imageStudio/freePipeline", () => ({
  runFreeStudioFlatten: quick.flatten,
  finishCutFromCutout: quick.flatten,
}));
vi.mock("@/lib/imageStudio/aiStudio", () => ({
  normalizeAiStudioImage: quick.flatten,
}));
vi.mock("@/lib/notify", () => ({
  notify: { ok: quick.ok, warn: quick.warn, err: quick.err },
}));
vi.mock("@/hooks/useOperationPermission", () => ({
  useOperationPermission: (operation: string) => ({
    allowed:
      !operation.endsWith("quickSaveBarcodeProductImage") || quick.canSave,
  }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      productStudio: { invalidate: quick.invalidate },
      catalog: {
        adminList: { invalidate: quick.invalidate },
        posList: { invalidate: quick.invalidate },
      },
    }),
    imageStudio: {
      aiConfig: {
        useQuery: () => ({ data: { aiAvailable: quick.aiAvailable } }),
      },
    },
    productStudio: {
      quickBarcodeLookup: {
        useQuery: (input: {
          productId?: number;
          variantId?: number;
          barcode?: string;
        }) => ({
          data:
            input.productId || input.barcode
              ? {
                  product: {
                    id: input.productId ?? (input.barcode === "A" ? 1 : 2),
                    variantId: input.variantId,
                    barcode: input.barcode,
                  },
                  images: [],
                  canAutoApprove: true,
                }
              : undefined,
          refetch: quick.refetch,
        }),
      },
      quickAiTransform: { useMutation: () => ({ mutateAsync: quick.ai }) },
      quickSaveBarcodeProductImage: {
        useMutation: () => ({ mutateAsync: quick.save }),
      },
    },
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("mobile studio workflow", () => {
  it("opens the worklist appropriate to the user's role", () => {
    expect(defaultStudioScope({ canManage: false, canAudit: false })).toBe(
      "MINE",
    );
    expect(defaultStudioScope({ canManage: true, canAudit: false })).toBe(
      "QUEUE",
    );
    expect(defaultStudioScope({ canManage: false, canAudit: true })).toBe(
      "HISTORY",
    );
  });

  it("switches a narrow screen from the task list to one full task detail", () => {
    expect(mobileStudioPanel(null)).toBe("LIST");
    expect(mobileStudioPanel(41)).toBe("DETAIL");
  });

  it("selects only an already-owned task after scanning its product", () => {
    const tasks = [
      { id: 7, productId: 12 },
      { id: 9, productId: 15 },
    ];
    expect(findScannedOwnedTask(tasks, 15)?.id).toBe(9);
    expect(findScannedOwnedTask(tasks, 30)).toBeUndefined();
  });

  it("toggles the mobile review image and bounds zoom controls", () => {
    expect(toggleStudioReviewImage("candidate")).toBe("original");
    expect(toggleStudioReviewImage("original")).toBe("candidate");
    expect(adjustStudioReviewZoom(1, "in")).toBe(1.25);
    expect(adjustStudioReviewZoom(3, "in")).toBe(3);
    expect(adjustStudioReviewZoom(0.5, "out")).toBe(0.5);
  });

  /**
   * ⚠️ **حدُّ هذا الاختبار:** يقرأ **نصّ الملفات** ولا يُصيّر شيئاً — فهو شبكةُ ارتدادٍ على
   * رموزٍ في الشيفرة، لا دليلٌ على أنّ زرّاً يظهر أو لا يحجبه شيء. مرورُه أخضرَ يتعايش مع
   * شاشةٍ مكسورة تماماً. لا تُعامله كإثباتٍ بصريّ ولا تُوسّعه؛ المنطق القابل للاختبار
   * فعلاً يُستخرَج إلى هذا الملف ويُختبَر كالدوالّ أعلاه.
   */
  it("markup regression net: key mobile tokens still present in source", () => {
    const read = (file: string) =>
      readFileSync(new NodeURL("../../" + file, import.meta.url), "utf8");
    const page = [
      "pages/ProductImageStudio.tsx",
      ...[
        "StudioPhotographerWorkspace",
        "StudioManagerDashboard",
        "StudioCampaignsPanel",
        "StudioTaskQueue",
        "StudioManualTaskCreator",
      ].map((name) => "components/product-studio/" + name + ".tsx"),
    ]
      .map(read)
      .join("\n");
    const uploader = read("components/form/ImageUploader.tsx");
    const studioUploader = read("components/product/ImageStudioUploader.tsx");
    const picker = read("components/product-studio/StudioProductPicker.tsx");
    const preview = read("components/product-studio/StudioPreviewPair.tsx");
    expect(page).toContain("عودة إلى المهام");
    expect(page).toContain("fixed bottom-24");
    expect(preview).toContain("الصورة الأصلية");
    expect(preview).toContain("المرشّح");
    expect(preview).toContain("تكبير الصورة");
    expect(page).toContain("STUDIO_REJECTION_PRESETS");
    expect(page).toContain("bulkAssign.mutate");
    expect(page).toContain("إسناد ${bulkProductIds.length} مهام");
    expect(page).toContain("studio-task-priority-filter");
    expect(page).toContain("studio-due-at");
    expect(page).toContain("studio-selected-due-at");
    expect(page).toContain("updateSchedule.mutate");
    expect(page).toContain("المتأخرة فقط");
    expect(page).toContain("وسيط زمن الدورة");
    expect(page).toContain("expectedRevision: selected.revision");
    expect(uploader).toContain("التقاط بالكاميرا الخلفية");
    expect(uploader).toContain("اختيار من المعرض");
    expect(uploader).toContain("إعادة الالتقاط");
    expect(uploader).toContain("معالجة بالذكاء الاصطناعي");
    expect(uploader).toContain("min-h-11");
    expect(uploader).not.toContain("group-hover:opacity-100");
    expect(studioUploader).toContain("عالج بالذكاء الاصطناعي");
    expect(studioUploader).toContain(
      "مقارنة قبل الاعتماد — الأصل الملتقط مقابل نتيجة الذكاء الاصطناعي",
    );
    expect(studioUploader).not.toContain("قصّ الخلفية (استوديو احترافي)");
    expect(studioUploader).not.toContain("توسيط على خلفية بيضاء");
    expect(page).toContain("mode: studioMode,");
    expect(page).not.toContain('mode: studioMode === "AI" ? "FLATTEN"');
    expect(picker).toContain("const CameraScanner = lazy");
    expect(picker).not.toContain("import { CameraScanner }");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("quick studio asynchronous capture and save", () => {
  let root: Root | null;
  let host: HTMLDivElement;
  let controller: ReturnType<typeof useQuickStudioController>;
  const targetA = { productId: 1, variantId: 11, barcode: "A" };
  const targetB = { productId: 2, variantId: 22, barcode: "B" };
  function Harness(props: QuickStudioProps) {
    controller = useQuickStudioController(props);
    return null;
  }
  const render = (externalTarget = targetA) =>
    act(async () => {
      root!.render(
        React.createElement(Harness, {
          externalTarget,
          onProductHandled: quick.handled,
        }),
      );
    });
  const capture = (name: string) =>
    controller.handleFileChange({
      target: { files: [new File(["image"], name)], value: "selected" },
    } as unknown as React.ChangeEvent<HTMLInputElement>);
  const ready = async () => {
    await render();
    await act(async () => {
      await capture("A");
    });
  };
  beforeEach(() => {
    Object.values(quick).forEach((value) => {
      if (vi.isMockFunction(value)) value.mockReset();
    });
    quick.canSave = true;
    quick.aiAvailable = false;
    quick.prepare.mockImplementation(async (file: File) => file.name);
    quick.flatten.mockImplementation(async (source: string) => ({
      dataUrl: "processed-" + source,
    }));
    quick.thumbnail.mockResolvedValue("thumb");
    quick.save.mockResolvedValue({ message: "saved" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    host.remove();
  });

  it("discards capture preparation after closing or replacing the target", async () => {
    const preparation = deferred<string>();
    quick.prepare.mockReturnValueOnce(preparation.promise);
    await render();
    let work!: Promise<void>;
    act(() => {
      work = capture("A");
      controller.closeModal();
    });
    await render(targetB);
    await act(async () => {
      preparation.resolve("old-a");
      await work;
    });
    expect(controller.product?.id).toBe(2);
    expect(controller.rawImage).toBeNull();
    expect(quick.flatten).not.toHaveBeenCalled();
  });

  it("does not let an old processing result unlock or contaminate a newer capture", async () => {
    const old = deferred<{ dataUrl: string }>();
    const next = deferred<{ dataUrl: string }>();
    quick.flatten
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    await render();
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => {
      first = capture("A");
    });
    await render(targetB);
    await act(async () => {
      second = capture("B");
    });
    await act(async () => {
      old.resolve({ dataUrl: "wrong-a" });
      await first;
    });
    expect(controller.rawImage).toBe("B");
    expect(controller.processedImage).toBeNull();
    expect(controller.isProcessingAi).toBe(true);
    await act(async () => {
      next.resolve({ dataUrl: "right-b" });
      await second;
    });
    await act(async () => {
      await controller.handleModeChange("FLATTEN");
      await controller.handleSubmitImage();
    });
    expect(quick.save).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 2,
        originalDataUrl: "B",
        processedDataUrl: "right-b",
      }),
    );
  });

  it("invalidates processing on cancel and ignores stale provider failures after unmount", async () => {
    quick.aiAvailable = true;
    const old = deferred<{ imageDataUrl: string }>();
    quick.ai.mockReturnValueOnce(old.promise);
    await render();
    let work!: Promise<void>;
    await act(async () => {
      work = capture("A");
    });
    act(() => controller.resetImageState());
    expect(controller.isProcessingAi).toBe(false);
    const generation = controller.getGeneration();
    await act(async () => root!.unmount());
    root = null;
    await act(async () => {
      old.reject(new Error("late provider failure"));
      await work;
    });
    expect(controller.isCurrent(generation)).toBe(false);
    expect(quick.flatten).not.toHaveBeenCalled();
    expect(quick.warn).not.toHaveBeenCalled();
    expect(quick.err).not.toHaveBeenCalled();
  });

  it("takes a synchronous save lock before thumbnail creation and retains it through the request", async () => {
    await ready();
    const thumbnail = deferred<string>(),
      saved = deferred<{ message: string }>();
    quick.thumbnail.mockReturnValueOnce(thumbnail.promise);
    quick.save.mockReturnValueOnce(saved.promise);
    let first!: Promise<void>;
    act(() => {
      first = controller.handleSubmitImage();
      void controller.handleSubmitImage();
    });
    expect(controller.isSaving).toBe(true);
    expect(quick.thumbnail).toHaveBeenCalledTimes(1);
    await act(async () => {
      thumbnail.resolve("thumb");
    });
    await act(async () => {
      await controller.handleSubmitImage();
    });
    expect(quick.save).toHaveBeenCalledTimes(1);
    await act(async () => {
      saved.resolve({ message: "saved" });
      await first;
    });
    expect(controller.isSaving).toBe(false);
    expect(controller.processedImage).toBeNull();
  });

  it("does not submit a thumbnail from a closed capture and releases the lock", async () => {
    await ready();
    const thumbnail = deferred<string>();
    quick.thumbnail.mockReturnValueOnce(thumbnail.promise);
    let work!: Promise<void>;
    act(() => {
      work = controller.handleSubmitImage();
      controller.closeModal();
    });
    await act(async () => {
      thumbnail.resolve("thumb");
      await work;
    });
    expect(quick.save).not.toHaveBeenCalled();
    expect(controller.isSaving).toBe(false);
  });

  it("keeps the newer snapshot when a previous product save finishes", async () => {
    await ready();
    const saved = deferred<{ message: string }>();
    quick.save.mockReturnValueOnce(saved.promise);
    let work!: Promise<void>;
    await act(async () => {
      work = controller.handleSubmitImage();
    });
    await render(targetB);
    await act(async () => {
      await capture("B");
    });
    await act(async () => {
      saved.resolve({ message: "saved A" });
      await work;
    });
    expect(controller.rawImage).toBe("B");
    expect(controller.processedImage).toBe("processed-B");
    expect(controller.product?.id).toBe(2);
    expect(quick.handled).toHaveBeenCalledExactlyOnceWith(1);
    expect(quick.refetch).not.toHaveBeenCalled();
    expect(quick.invalidate).toHaveBeenCalledTimes(3);
  });
});
