import type { ControllerEnv } from "../app/env.js";
import { proxyFetch } from "../lib/proxy-fetch.js";

/** Loopback health checks should answer in milliseconds; 3s is already a fault. */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;

export class RuntimeHealth {
  constructor(private readonly env: ControllerEnv) {}

  async probe(): Promise<{ ok: boolean; status: number | null }> {
    if (!this.env.gatewayProbeEnabled) {
      return { ok: true, status: null };
    }

    try {
      // Bound the probe: a hung socket on a loopback health check must not
      // stall the startup/health loop indefinitely.
      const response = await proxyFetch(
        `http://127.0.0.1:${this.env.openclawGatewayPort}/health`,
        { timeoutMs: HEALTH_PROBE_TIMEOUT_MS },
      );
      return {
        ok: response.ok,
        status: response.status,
      };
    } catch {
      return {
        ok: false,
        status: null,
      };
    }
  }
}
