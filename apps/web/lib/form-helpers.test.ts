import { describe, expect, it } from "vitest";

import { emptyToNull, emptyToUndefined, selectToNull } from "./form-helpers";

describe("emptyToNull", () => {
  it("turns a cleared field into null, not an empty string", () => {
    expect(emptyToNull("")).toBeNull();
    expect(emptyToNull("   ")).toBeNull();
  });

  it("trims a value that has one", () => {
    expect(emptyToNull("  bir aciklama  ")).toBe("bir aciklama");
  });
});

describe("emptyToUndefined", () => {
  it("omits the field so a PATCH leaves it alone", () => {
    expect(emptyToUndefined("")).toBeUndefined();
  });

  it("keeps a real value", () => {
    expect(emptyToUndefined("2026-10-01")).toBe("2026-10-01");
  });
});

describe("selectToNull", () => {
  it("reads the empty option as no group, which is a cross-group record", () => {
    expect(selectToNull("")).toBeNull();
  });

  it("passes an id through untouched", () => {
    expect(selectToNull("group-1")).toBe("group-1");
  });
});
