import { describe, expect, it } from "vitest";

import { formatDate, formatMoney, toDateInput } from "./format";

describe("formatMoney", () => {
  it("keeps two decimals whatever the value looks like", () => {
    // The API already rounds to the column's two places; the job here is only
    // to stop 25000.00 rendering as "25000" next to "4750,50".
    expect(formatMoney("25000.00")).toBe("25.000,00 TL");
    expect(formatMoney("4750.50")).toBe("4.750,50 TL");
    expect(formatMoney("0.00")).toBe("0,00 TL");
  });

  it("handles a negative net", () => {
    expect(formatMoney("-1200.00")).toBe("-1.200,00 TL");
  });

  it("shows a dash rather than 0 for a missing amount", () => {
    // A sponsorship with no pledged amount is not a sponsorship worth nothing.
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
  });

  it("returns the raw value rather than NaN if it is not a number", () => {
    expect(formatMoney("bilinmiyor")).toBe("bilinmiyor");
  });
});

describe("formatDate", () => {
  it("renders an ISO string in Turkish", () => {
    expect(formatDate("2026-09-01T17:00:00.000Z")).toMatch(/2026/);
  });

  it("shows a dash for a missing date", () => {
    expect(formatDate(null)).toBe("—");
  });
});

describe("toDateInput", () => {
  it("gives a date input the only format it accepts", () => {
    expect(toDateInput("2026-09-01T17:00:00.000Z")).toBe("2026-09-01");
  });

  it("is empty rather than invalid when there is no date", () => {
    expect(toDateInput(null)).toBe("");
  });
});
