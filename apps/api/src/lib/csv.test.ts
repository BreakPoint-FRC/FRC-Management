import { describe, expect, it } from "vitest";

import { parseAccountsCsv } from "./csv";

describe("parseAccountsCsv", () => {
  it("parses a plain file", () => {
    const result = parseAccountsCsv("fullName,email\nAda Yılmaz,ada@example.com\nKerem Kaya,kerem@example.com\n");

    expect(result.error).toBeNull();
    expect(result.rows).toEqual([
      { line: 2, fullName: "Ada Yılmaz", email: "ada@example.com" },
      { line: 3, fullName: "Kerem Kaya", email: "kerem@example.com" },
    ]);
  });

  it("accepts the columns in either order", () => {
    const result = parseAccountsCsv("email,fullName\nada@example.com,Ada Yılmaz\n");

    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ line: 2, fullName: "Ada Yılmaz", email: "ada@example.com" }]);
  });

  it("matches the header case-insensitively", () => {
    const result = parseAccountsCsv("FullName,Email\nAda Yılmaz,ada@example.com\n");

    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
  });

  it("handles a quoted field containing a comma", () => {
    const result = parseAccountsCsv('fullName,email\n"Yılmaz, Ada",ada@example.com\n');

    expect(result.rows[0]?.fullName).toBe("Yılmaz, Ada");
  });

  it("handles an escaped quote inside a quoted field", () => {
    const result = parseAccountsCsv('fullName,email\n"Ada ""AY"" Yılmaz",ada@example.com\n');

    expect(result.rows[0]?.fullName).toBe('Ada "AY" Yılmaz');
  });

  it("handles a quoted field spanning a line break", () => {
    const result = parseAccountsCsv('fullName,email\n"Ada\nYılmaz",ada@example.com\n');

    expect(result.rows[0]?.fullName).toBe("Ada\nYılmaz");
  });

  it("rejects an unclosed quoted field instead of silently accepting corrupted data", () => {
    const result = parseAccountsCsv('fullName,email\n"Ada Yılmaz,ada@example.com\n');

    expect(result.rows).toEqual([]);
    expect(result.error).toMatch(/kapanmamış tırnak/i);
  });

  it("rejects characters appended after a closing quote", () => {
    const result = parseAccountsCsv('fullName,email\n"Ada"oops,ada@example.com\n');

    expect(result.rows).toEqual([]);
    expect(result.error).toMatch(/beklenmeyen karakter/i);
  });

  it("handles CRLF line endings", () => {
    const result = parseAccountsCsv("fullName,email\r\nAda Yılmaz,ada@example.com\r\n");

    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ line: 2, fullName: "Ada Yılmaz", email: "ada@example.com" }]);
  });

  it("skips blank lines rather than treating them as data", () => {
    const result = parseAccountsCsv("fullName,email\n\nAda Yılmaz,ada@example.com\n\n\n");

    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ line: 3, fullName: "Ada Yılmaz", email: "ada@example.com" }]);
  });

  it("strips a leading UTF-8 BOM before reading the header", () => {
    const result = parseAccountsCsv("﻿fullName,email\nAda Yılmaz,ada@example.com\n");

    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
  });

  it("trims surrounding whitespace from unquoted fields", () => {
    const result = parseAccountsCsv("fullName,email\n  Ada Yılmaz  ,  ada@example.com  \n");

    expect(result.rows[0]).toEqual({ line: 2, fullName: "Ada Yılmaz", email: "ada@example.com" });
  });

  it("preserves a trailing empty field", () => {
    const result = parseAccountsCsv("fullName,email\nAda Yılmaz,\n");

    expect(result.rows[0]?.email).toBe("");
  });

  it("rejects an empty file", () => {
    expect(parseAccountsCsv("").error).toBe("Dosya boş.");
    expect(parseAccountsCsv("   \n  \n").error).toBe("Dosya boş.");
  });

  it("rejects a header missing a required column", () => {
    const result = parseAccountsCsv("fullName,phone\nAda Yılmaz,5551234567\n");

    expect(result.error).toMatch(/Başlık/);
    expect(result.rows).toEqual([]);
  });

  it("rejects a file with a header but no data rows", () => {
    const result = parseAccountsCsv("fullName,email\n");

    expect(result.error).toBe("Hesap satırı yok.");
  });

  it("rejects more than 250 data rows", () => {
    const rows = Array.from({ length: 251 }, (_, i) => `Kisi ${i},kisi${i}@example.com`).join("\n");
    const result = parseAccountsCsv(`fullName,email\n${rows}\n`);

    expect(result.error).toMatch(/250/);
    expect(result.rows).toEqual([]);
  });

  it("accepts exactly 250 data rows", () => {
    const rows = Array.from({ length: 250 }, (_, i) => `Kisi ${i},kisi${i}@example.com`).join("\n");
    const result = parseAccountsCsv(`fullName,email\n${rows}\n`);

    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(250);
  });

  it("rejects a file over the size limit", () => {
    const huge = "fullName,email\n" + "a".repeat(300_001);

    expect(parseAccountsCsv(huge).error).toBe("Dosya çok büyük.");
  });
});
