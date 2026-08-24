import { describe, expect, it } from "vitest";

const expoToken = process.env.EXPO_TOKEN;
const runEasAuthTest = process.env.RUN_EAS_AUTH_TEST === "1";

describe("Expo/EAS access token", () => {
  it.skipIf(!expoToken || !runEasAuthTest)("authenticates against the Expo profile endpoint", async () => {
    const response = await fetch("https://api.expo.dev/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${expoToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "query { meActor { __typename } }" }),
    });
    const payload = await response.json() as { data?: { meActor?: { __typename?: string } | null }; errors?: Array<{ message?: string }> };
    expect(response.ok, payload.errors?.map((error) => error.message).join(", ")).toBe(true);
    expect(payload.errors ?? []).toHaveLength(0);
    expect(payload.data?.meActor?.__typename).toBeTruthy();
  });
});
