import { describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { createMemberSchema } from "./members.schema";

describe("members.schema", () => {
  it("accepts a valid member payload", () => {
    const result = createMemberSchema.safeParse({
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "STUDENT",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = createMemberSchema.safeParse({
      name: "Ada Lovelace",
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("returns a structured 400 response for invalid input", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/members",
      payload: { name: "", email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
      message: "Invalid request",
      issues: expect.any(Array),
    });

    await app.close();
  });
});
