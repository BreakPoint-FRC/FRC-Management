import { describe, expect, it } from "vitest";

import { buildCredentialsCsv } from "./credentials-csv";

describe("buildCredentialsCsv", () => {
  it("quotes commas, quotes and line breaks without breaking the row", () => {
    const csv = buildCredentialsCsv([
      {
        fullName: 'Yılmaz, Ada "AY"\nKaptan',
        email: "ada@example.com",
        temporaryPassword: "Temporary234",
      },
    ]);

    expect(csv).toContain('"Yılmaz, Ada ""AY""\nKaptan","ada@example.com","Temporary234"');
  });

  it.each(["=2+2", "+SUM(1,1)", "-1+2", "@IMPORTXML(x)", "\t=cmd", "\r=cmd"])(
    "neutralizes spreadsheet formula prefix %j",
    (fullName) => {
      const csv = buildCredentialsCsv([
        { fullName, email: "member@example.com", temporaryPassword: "Temporary234" },
      ]);

      expect(csv.split("\n")[1]).toContain(`"'${fullName.replace(/"/g, '""')}"`);
    }
  );
});
