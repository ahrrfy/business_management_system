import { describe, expect, it, vi } from "vitest";
import { dispatchManualCameraEntry } from "./cameraScannerLifecycle";
import { readFileSync } from "node:fs";

it("clears torch UI state when the owned camera is stopped or fails to reopen", () => {
  const source = readFileSync("client/src/components/scan/CameraScanner.tsx", "utf8");
  const cleanup = source.slice(source.indexOf("const stop = () =>"), source.indexOf("const setTorchCapability"));
  expect(cleanup).toContain("setTorchAvailable(false)");
  expect(cleanup).toContain("setTorchOn(false)");
});

describe("manual camera entry lifecycle", () => {
  it("uses the normal delivery lifecycle when no manual override exists", () => {
    const deliver = vi.fn();
    const stopMedia = vi.fn();
    const manual = vi.fn();
    dispatchManualCameraEntry("1  0095", { deliver, stopMedia, manual, hasManualOverride: false });
    expect(deliver).toHaveBeenCalledWith("1  0095");
    expect(stopMedia).not.toHaveBeenCalled();
    expect(manual).not.toHaveBeenCalled();
  });

  it("stops media only for an explicit manual override", () => {
    const deliver = vi.fn();
    const stopMedia = vi.fn();
    const manual = vi.fn();
    dispatchManualCameraEntry("B1", { deliver, stopMedia, manual, hasManualOverride: true });
    expect(stopMedia).toHaveBeenCalledOnce();
    expect(manual).toHaveBeenCalledWith("B1");
    expect(deliver).not.toHaveBeenCalled();
  });
});
