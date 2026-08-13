import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_CLOUD_URL,
  PRODUCTION_LINK_URL,
  assertBuildEndpointPolicy,
  resolveBuildEndpoints,
  verifyBuildEndpointConnectivity,
} from "#desktop/scripts/lib/build-endpoints.mjs";

describe("desktop build endpoint policy", () => {
  it("uses the live production Cloud and Link defaults", () => {
    expect(resolveBuildEndpoints()).toEqual({
      NEXU_CLOUD_URL: PRODUCTION_CLOUD_URL,
      NEXU_LINK_URL: PRODUCTION_LINK_URL,
    });
  });

  it("rejects stale endpoints in a formal package", () => {
    expect(() =>
      assertBuildEndpointPolicy({
        NEXU_DESKTOP_BUILD_SOURCE: "release",
        NEXU_CLOUD_URL: "https://api.clawpi.app:9443",
        NEXU_LINK_URL: "https://api.clawpi.app:9443",
      }),
    ).toThrow("Formal packages must use");
  });

  it("accepts the expected Cloud catalog and authenticated Link responses", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = input.toString();
      return new Response(null, {
        status: url.startsWith(PRODUCTION_CLOUD_URL) ? 200 : 401,
      });
    });
    const lookupImpl = vi.fn(async () => ({ address: "127.0.0.1", family: 4 }));

    await expect(
      verifyBuildEndpointConnectivity(
        {
          NEXU_DESKTOP_BUILD_SOURCE: "release",
          NEXU_CLOUD_URL: PRODUCTION_CLOUD_URL,
          NEXU_LINK_URL: PRODUCTION_LINK_URL,
        },
        { fetchImpl, lookupImpl, timeoutMs: 100 },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ label: "Cloud", status: 200 }),
      expect.objectContaining({ label: "Link", status: 401 }),
    ]);
    expect(lookupImpl).toHaveBeenCalledWith("api.openlux.ai");
  });

  it("reports DNS failures distinctly during packaging", async () => {
    const dnsError = Object.assign(new Error("not found"), {
      code: "ENOTFOUND",
    });

    await expect(
      verifyBuildEndpointConnectivity(
        {
          NEXU_CLOUD_URL: "https://cloud.invalid.example",
          NEXU_LINK_URL: "https://link.invalid.example",
        },
        {
          fetchImpl: vi.fn(),
          lookupImpl: vi.fn(async () => {
            throw dnsError;
          }),
          timeoutMs: 100,
        },
      ),
    ).rejects.toThrow("DNS failure (ENOTFOUND)");
  });
});
