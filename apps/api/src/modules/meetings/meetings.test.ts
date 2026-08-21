import { describe, expect, it } from "vitest";
import { rollCallSchema } from "./meetings.schema";

describe("meetings.schema", () => {
  it("accepts a roll call payload", () => {
    const result = rollCallSchema.safeParse({
      attendance: [{ memberId: "m1", present: true }],
    });
    expect(result.success).toBe(true);
  });
});
