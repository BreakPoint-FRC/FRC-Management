// A small RFC 4180 tokenizer, not a library: bulk account import is the one
// place this project reads a CSV, and the exact quoting/newline rules matter
// enough (a name with a comma, a quoted field spanning a line break) that a
// dependency's behavior is not obviously worth trusting over a parser small
// enough to read in one sitting and unit-test exhaustively.

export interface AccountCsvRow {
  /** 1-based position among the file's rows, header included -- for messages
   *  like "satır 4", not a byte-exact source line when a field spans lines. */
  line: number;
  fullName: string;
  email: string;
}

export interface AccountCsvResult {
  rows: AccountCsvRow[];
  /** Set instead of `rows` when the file itself cannot be read as account
   *  rows -- too big, no header, no data. Never set alongside populated rows. */
  error: string | null;
}

const MAX_ROWS = 250;
const MAX_LENGTH = 300_000;

/** Splits raw CSV text into records of raw (already unescaped) field strings. */
function tokenize(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function endField() {
    record.push(field);
    field = "";
  }
  function endRecord() {
    endField();
    records.push(record);
    record = [];
  }

  while (i < n) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRecord();
      i += 1;
      continue;
    }
    if (char === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // A trailing field or record with no closing newline still counts -- most
  // hand-edited or pasted files end this way.
  if (field.length > 0 || record.length > 0) endRecord();

  return records;
}

/**
 * Parses "fullName,email" rows for bulk account import.
 *
 * The header names the columns rather than fixing their order or count, so a
 * spreadsheet export with the columns swapped, or extra ones Excel added,
 * still works. Blank lines are skipped rather than treated as malformed rows,
 * because a trailing newline is the common case, not the exception.
 */
export function parseAccountsCsv(text: string): AccountCsvResult {
  // Strips a UTF-8 BOM: Excel writes one on "CSV UTF-8" exports, and left in
  // place it would hide inside the first header cell and fail the header
  // check on a file that looks correct to a person reading it.
  const BOM = String.fromCharCode(0xfeff);
  const normalized = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  if (normalized.length > MAX_LENGTH) {
    return { rows: [], error: "Dosya çok büyük." };
  }
  if (normalized.trim().length === 0) {
    return { rows: [], error: "Dosya boş." };
  }

  const records = tokenize(normalized)
    .map((fields, index) => ({ fields, line: index + 1 }))
    .filter(({ fields }) => !fields.every((field) => field.trim() === ""));

  if (records.length === 0) {
    return { rows: [], error: "Dosya boş." };
  }

  const header = records[0]!.fields.map((field) => field.trim().toLowerCase());
  const nameIndex = header.indexOf("fullname");
  const emailIndex = header.indexOf("email");
  if (nameIndex === -1 || emailIndex === -1) {
    return { rows: [], error: 'Başlık satırı "fullName,email" olmalı.' };
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    return { rows: [], error: "Hesap satırı yok." };
  }
  if (dataRecords.length > MAX_ROWS) {
    return { rows: [], error: `En fazla ${MAX_ROWS} hesap eklenebilir.` };
  }

  const rows = dataRecords.map(({ fields, line }) => ({
    line,
    fullName: (fields[nameIndex] ?? "").trim(),
    email: (fields[emailIndex] ?? "").trim(),
  }));

  return { rows, error: null };
}
