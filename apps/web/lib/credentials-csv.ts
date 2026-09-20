export interface TemporaryCredentialRow {
  fullName: string;
  email: string;
  temporaryPassword: string;
}

/**
 * Produces a spreadsheet-safe credential hand-off file.
 *
 * CSV quoting preserves commas, quotes and line breaks, but it does not stop
 * Excel/Sheets from interpreting an uploaded name beginning with =, +, -, @,
 * tab or carriage return as a formula. Prefixing those values with an
 * apostrophe is the established literal-text escape used by spreadsheets.
 */
export function buildCredentialsCsv(rows: readonly TemporaryCredentialRow[]): string {
  const cell = (value: string) => {
    const literal = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${literal.replace(/"/g, '""')}"`;
  };

  return [
    "fullName,email,temporaryPassword",
    ...rows.map((row) => [row.fullName, row.email, row.temporaryPassword].map(cell).join(",")),
  ].join("\n");
}
