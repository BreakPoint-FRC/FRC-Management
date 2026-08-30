import { describe, expect, it } from "vitest";

import { ApiError } from "./api-client";
import { isFormLevel, issueFor } from "./issues";

const validation = new ApiError(400, "Invalid request", [
  { path: ["dueDate"], message: "Bitis tarihi baslangictan once olamaz" },
  { path: ["roles", 1], message: "Bu rol zaten listede var" },
  { path: ["roles", 2, "groupId"], message: "Grup secilmeli" },
]);

describe("issueFor", () => {
  it("finds a plain field", () => {
    expect(issueFor(validation, "dueDate")).toBe("Bitis tarihi baslangictan once olamaz");
  });

  it("finds an entry in a list by index", () => {
    expect(issueFor(validation, "roles", 1)).toBe("Bu rol zaten listede var");
  });

  it("matches by prefix, so a row sees its own sub-field complaints", () => {
    // The row control does not need to know that the message is really about
    // groupId -- it just needs to show something is wrong with this row.
    expect(issueFor(validation, "roles", 2)).toBe("Grup secilmeli");
  });

  it("still finds the exact sub-field when asked for it", () => {
    expect(issueFor(validation, "roles", 2, "groupId")).toBe("Grup secilmeli");
  });

  it("returns undefined for a field with no complaint", () => {
    expect(issueFor(validation, "name")).toBeUndefined();
    expect(issueFor(validation, "roles", 5)).toBeUndefined();
  });

  it("survives an error with no issues at all", () => {
    expect(issueFor(new ApiError(403, "Yetkiniz yok"), "name")).toBeUndefined();
    expect(issueFor(null, "name")).toBeUndefined();
  });
});

describe("isFormLevel", () => {
  it("is false for a validation error, which is shown per field", () => {
    expect(isFormLevel(validation)).toBe(false);
  });

  it("is true for a 403 or 409, which has nowhere else to go", () => {
    expect(isFormLevel(new ApiError(403, "Bu grubun uyesi degilsiniz"))).toBe(true);
    expect(isFormLevel(new ApiError(409, "Sistem rolleri silinemez"))).toBe(true);
  });

  it("is false when there is no error", () => {
    expect(isFormLevel(null)).toBe(false);
  });
});
