import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./api-client";

describe("apiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles successful responses without a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 204,
        statusText: "No Content",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiClient.delete("/tasks/task-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/tasks/task-1",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
