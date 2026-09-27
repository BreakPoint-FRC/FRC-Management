import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAllPages } from "./use-api";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const page = (items: number[], pageNum: number, totalPages: number) =>
  json({ items, page: pageNum, pageSize: 100, total: totalPages * 100, totalPages });

describe("fetchAllPages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a single page's items without asking for a second page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([1, 2, 3], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllPages("/accounts")).resolves.toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The exact bug this exists to fix: a roster of 250 accounts is 3 pages at
  // the server's 100-per-page cap (packages/types/src/pagination.ts), and a
  // picker built on only the first response silently drops accounts 101-250.
  it("walks every page the server reports and merges them in order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], 1, 3))
      .mockResolvedValueOnce(page([3, 4], 2, 3))
      .mockResolvedValueOnce(page([5, 6], 3, 3));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllPages("/accounts")).resolves.toEqual([1, 2, 3, 4, 5, 6]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("appends page and pageSize onto a path that already carries other filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([1], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAllPages("/accounts?groupId=g1", 50);

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("groupId")).toBe("g1");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("pageSize")).toBe("50");
  });

  it("requests pages 2..N with the same pageSize as page 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([1], 1, 2))
      .mockResolvedValueOnce(page([2], 2, 2));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAllPages("/accounts", 50);

    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("page")).toBe("2");
    expect(secondUrl.searchParams.get("pageSize")).toBe("50");
  });

  it("replaces stale paging parameters instead of sending duplicates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([1], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAllPages("/accounts?search=ada&page=9&pageSize=1", 50);

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("search")).toBe("ada");
    expect(url.searchParams.getAll("page")).toEqual(["1"]);
    expect(url.searchParams.getAll("pageSize")).toEqual(["50"]);
  });

  it("propagates a failure from any page rather than returning a partial list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Sunucu hatasi" }), { status: 500 }))
    );

    await expect(fetchAllPages("/accounts")).rejects.toMatchObject({ status: 500 });
  });
});
