import { test, expect, type Page } from "@playwright/test";

const read = { canRead: true, canCreate: false, canUpdate: false, canDelete: false };
const rows = Array.from({ length: 26 }, (_, index) => ({
  id: `audit-${index}`, teamId: "team", actorId: "actor", actor: { id: "actor", fullName: `Actor ${index}` },
  entityType: "ROLE", entityId: `role-${index}`, action: "ROLE_PERMISSIONS_REPLACED",
  oldValue: [{ tool: "TASKS", ...read }], newValue: [{ tool: "TASKS", ...read, canUpdate: true }],
  createdAt: "2026-09-06T12:00:00Z",
}));

async function login(page: Page, grant: "audit" | "roles" | "group" = "audit") {
  await page.route("**/auth/login", (route) => route.fulfill({ json: { accessToken: "test", refreshToken: "test" } }));
  await page.route("**/auth/me", (route) => route.fulfill({ json: {
    account: { id: "actor", fullName: "Reader", email: "reader@example.test", teamId: "team", mustChangePassword: false },
    team: { id: "team", name: "Test", setupStage: "DONE" }, roles: [], groups: [],
    permissions: { global: grant === "audit" ? { AUDIT_LOG: read } : grant === "roles" ? { ROLES: read } : {},
      byGroup: grant === "group" ? { group: { AUDIT_LOG: read } } : {} },
  } }));
  await page.goto("/login");
  await page.getByLabel("E-posta").fill("reader@example.test");
  await page.getByLabel("Sifre", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Giris yap", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cikis yap" })).toBeVisible();
}

test("paginates, filters, validates dates and clears back to page one", async ({ page }) => {
  const queries: URL[] = [];
  await page.route("http://localhost:4100/audit-log?*", async (route) => {
    const url = new URL(route.request().url()); queries.push(url);
    const current = Number(url.searchParams.get("page"));
    const empty = url.searchParams.get("entityType") === "GROUP";
    await route.fulfill({ json: { items: empty ? [] : rows.slice((current - 1) * 25, current * 25), page: current, pageSize: 25, total: empty ? 0 : 26, totalPages: empty ? 0 : 2 } });
  });
  await login(page);
  await expect(page.getByRole("link", { name: "Roller", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Denetim kaydi" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await expect(page.getByRole("button", { name: "Onceki" })).toBeDisabled();
  await page.getByRole("button", { name: "Sonraki" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("Actor 25");
  await expect(page.getByRole("button", { name: "Sonraki" })).toBeDisabled();
  await page.getByRole("button", { name: "Onceki" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await page.getByLabel("Kayit turu").selectOption("GROUP");
  await page.getByLabel("Baslangic").fill("2026-09-07");
  await page.getByLabel("Bitis").fill("2026-09-06");
  await page.getByRole("button", { name: "Uygula" }).click();
  expect(await page.getByLabel("Baslangic").evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  expect(queries.at(-1)!.searchParams.has("entityType")).toBe(false);
  await page.getByLabel("Baslangic").fill("2026-09-01");
  await page.getByRole("button", { name: "Uygula" }).click();
  await expect(page.getByText("Filtrelere uygun denetim kaydi yok.")).toBeVisible();
  expect(Object.fromEntries(queries.at(-1)!.searchParams)).toEqual({ page: "1", pageSize: "25", entityType: "GROUP", from: "2026-08-31T21:00:00.000Z", to: "2026-09-06T20:59:59.999Z" });
  await page.getByRole("button", { name: "Temizle" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  expect(Object.fromEntries(queries.at(-1)!.searchParams)).toEqual({ page: "1", pageSize: "25" });
});

test("shows changed account assignments beyond the unchanged prefix", async ({ page }) => {
  await page.route("http://localhost:4100/audit-log?*", (route) => route.fulfill({ json: {
    items: [{ ...rows[0], entityType: "ACCOUNT", action: "ACCOUNT_ROLES_REPLACED",
      oldValue: ["a", "b", "c", "removed-role"].map((roleId) => ({ roleId, groupId: null })),
      newValue: ["a", "b", "c", "added-role"].map((roleId) => ({ roleId, groupId: null })),
    }], page: 1, pageSize: 25, total: 1, totalPages: 1,
  } }));
  await login(page);
  await page.getByRole("link", { name: "Denetim kaydi" }).click();
  const sides = page.locator(".audit-log-change > span");
  await expect(sides.nth(0)).toHaveText("removed-role");
  await expect(sides.nth(2)).toHaveText("added-role");
});

for (const failure of ["500", "network", "empty", "403"] as const) {
  test(`renders ${failure} and retries recoverable failures`, async ({ page }) => {
    let recovered = false;
    await page.route("http://localhost:4100/audit-log?*", (route) => {
      if (recovered || failure === "empty") return route.fulfill({ json: { items: [], total: 0, totalPages: 0, page: 1, pageSize: 25 } });
      if (failure === "network") return route.abort();
      return route.fulfill({ status: Number(failure), json: { message: "Test server error" } });
    });
    await login(page);
    await page.getByRole("link", { name: "Denetim kaydi" }).click();
    await expect(page.locator("tbody")).toHaveCount(0);
    if (failure === "403") await expect(page.locator("main [role=alert]")).toHaveText("Denetim kaydini goruntuleme yetkiniz yok.");
    else if (failure === "empty") await expect(page.getByText("Filtrelere uygun denetim kaydi yok.")).toBeVisible();
    else {
      await expect(page.getByText(failure === "network" ? "Internet baglantisi yok" : "Test server error", { exact: true })).toBeVisible();
      recovered = true;
      await page.getByRole("button", { name: "Tekrar dene" }).click();
      await expect(page.getByText("Filtrelere uygun denetim kaydi yok.")).toBeVisible();
    }
  });
}

test("disables paging while pending and removes stale rows when access is revoked", async ({ page }) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("http://localhost:4100/audit-log?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "2") {
      await pending;
      return route.fulfill({ status: 403, json: { message: "Forbidden" } });
    }
    return route.fulfill({ json: { items: rows.slice(0, 25), page: 1, pageSize: 25, total: 26, totalPages: 2 } });
  });
  await login(page);
  await page.getByRole("link", { name: "Denetim kaydi" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await page.getByRole("button", { name: "Sonraki" }).click();
  await expect(page.getByRole("button", { name: "Sonraki" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Onceki" })).toBeDisabled();
  release();
  await expect(page.locator("main [role=alert]")).toContainText("yetkiniz yok");
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

for (const grant of ["roles", "group"] as const) {
  test(`hides audit navigation for ${grant} access`, async ({ page }) => {
    await page.route("http://localhost:4100/audit-log?*", (route) => route.fulfill({ status: 403, json: { message: "Forbidden" } }));
    await login(page, grant);
    await expect(page.getByRole("link", { name: "Denetim kaydi" })).toHaveCount(0);
  });
}

for (const width of [360, 1280]) for (const colorScheme of ["light", "dark"] as const) {
  test(`layout ${width}px ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.route("http://localhost:4100/audit-log?*", (route) => route.fulfill({ json: { items: [{ ...rows[0], actor: { id: "actor", fullName: "LongActorName".repeat(15) }, entityId: "long-id".repeat(30) }], page: 1, pageSize: 25, total: 1, totalPages: 1 } }));
    await login(page);
    await page.getByRole("link", { name: "Denetim kaydi" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "Uygula" })).toBeInViewport();
    const change = page.locator(".audit-log-change");
    await change.scrollIntoViewIfNeeded();
    await expect(change).toBeInViewport();
    await expect(change).toContainText("Guncelleme");
    await page.screenshot({ path: testInfo.outputPath("audit-log.png"), fullPage: true });
  });
}
