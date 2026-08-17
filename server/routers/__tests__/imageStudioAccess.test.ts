import { describe, expect, it } from "vitest";
import { imageStudioRouter } from "../imageStudioRouter";

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function caller(role: string, productStudio?: "FULL" | "READ" | "NONE") {
  return imageStudioRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 92,
      role,
      branchId: 1,
      permissionsOverride: productStudio ? { productStudio } : null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("image studio worker permission", () => {
  it("blocks a user without productStudio FULL before calling the provider", async () => {
    await expect(caller("cashier").proCutout({ imageDataUrl: PNG_1X1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets the combined photo/content role reach the guarded provider path", async () => {
    await expect(caller("print_operator").proCutout({ imageDataUrl: PNG_1X1 }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
