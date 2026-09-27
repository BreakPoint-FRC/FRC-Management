import { describe, expect, it } from "vitest";

import { dashboardQuerySchema } from "./dashboard.schema";

describe("dashboard day query", () => {
  it("preserves the browser-local calendar day as a UTC date-only value", () => {
    const query = dashboardQuerySchema.parse({ today: "2028-02-29" });
    expect(query.today.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "is independent from the API server timezone (%s)",
    (serverTimeZone) => {
      const originalTimeZone = process.env.TZ;
      try {
        process.env.TZ = serverTimeZone;
        const query = dashboardQuerySchema.parse({ today: "2026-09-15" });
        expect(query.today.toISOString()).toBe("2026-09-15T00:00:00.000Z");
      } finally {
        if (originalTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimeZone;
      }
    }
  );

  it.each([
    ["missing", {}],
    ["non-padded", { today: "2026-9-5" }],
    ["nonexistent", { today: "2026-02-30" }],
    ["non-leap-year", { today: "2025-02-29" }],
    ["timestamp", { today: "2026-09-15T00:00:00Z" }],
    ["unexpected-field", { today: "2026-09-15", extra: "field" }],
  ])("rejects a %s query", (_case, query) => {
    expect(dashboardQuerySchema.safeParse(query).success).toBe(false);
  });
});

