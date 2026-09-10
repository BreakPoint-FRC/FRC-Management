import { test, expect } from "@playwright/test";
import type { Paginated } from "@breakpoint/types";
import type { AuditLogRow, RoleRow } from "../lib/api-types";

// Opt in only against an isolated, migrated and seeded local test database.
test("a saved role permission appears in the real audit trail", async ({ page }) => {
  test.skip(process.env.AUDIT_E2E_REAL !== "1", "Requires isolated seeded API on localhost:4100");
  await page.goto("/login");
  await page.getByLabel("E-posta").fill("ada@breakpoint.test");
  await page.getByLabel("Sifre", { exact: true }).fill("Breakpoint2026!");
  const loggedIn = page.waitForResponse((response) => response.url().endsWith("/auth/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Giris yap", exact: true }).click();
  const loginResponse = await loggedIn;
  const apiOrigin = new URL(loginResponse.url()).origin;
  const { accessToken } = await loginResponse.json();
  const rolesLoaded = page.waitForResponse((response) => response.url().startsWith(`${apiOrigin}/roles?`) && response.request().method() === "GET");
  await page.getByRole("link", { name: "Roller", exact: true }).click();
  const rolesResponse = await rolesLoaded;
  const roles: Paginated<RoleRow> = await rolesResponse.json();
  const memberRole = roles.items.find((role) => role.key === "MEMBER");
  expect(memberRole).toBeTruthy();
  const roleId = memberRole!.id;
  const originalPermissions = memberRole!.permissions.map((permission) => ({
    tool: permission.tool,
    canRead: permission.canRead,
    canCreate: permission.canCreate,
    canUpdate: permission.canUpdate,
    canDelete: permission.canDelete,
  }));
  const roleRow = page.locator("tr").filter({ has: page.getByRole("cell", { name: "MEMBER", exact: true }) });
  await roleRow.getByRole("button", { name: "Yetkiler" }).click();
  const permissionsUrl = new URL(`/roles/${roleId}/permissions`, rolesResponse.url());
  const beforeResponse = await page.request.get(`${permissionsUrl.origin}/audit-log`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { entityType: "ROLE", entityId: roleId, pageSize: 100 },
  });
  expect(beforeResponse.status()).toBe(200);
  const before: Paginated<AuditLogRow> = await beforeResponse.json();
  const existingIds = new Set(before.items.map((row) => row.id));
  const tasks = page.locator("form tr").filter({ has: page.getByRole("cell", { name: "TASKS", exact: true }) });
  const update = tasks.getByRole("checkbox").nth(2);
  const previous = await update.isChecked();
  let mutationAttempted = false;
  try {
    await update.setChecked(!previous);
    const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/permissions"));
    mutationAttempted = true;
    await page.getByRole("button", { name: "Kaydet", exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(204);
    expect(new URL(response.url()).pathname).toBe(permissionsUrl.pathname);
    const auditLoaded = page.waitForResponse((response) => response.url().startsWith(`${apiOrigin}/audit-log?`) && response.request().method() === "GET");
    await page.getByRole("link", { name: "Denetim kaydi" }).click();
    const auditResponse = await auditLoaded;
    expect(auditResponse.status()).toBe(200);
    const history: Paginated<AuditLogRow> = await auditResponse.json();
    const fresh = history.items.filter((row) => row.entityId === roleId &&
      row.action === "ROLE_PERMISSIONS_REPLACED" && !existingIds.has(row.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].newValue).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "TASKS", canUpdate: !previous }),
    ]));
    const audit = page.locator(`tbody tr[data-audit-id="${fresh[0].id}"]`);
    await expect(audit).toContainText("Ada Yilmaz");
    await expect(audit).toContainText("Rol izinleri degistirildi");
    await expect(audit).toContainText("TASKS");
    const sides = audit.locator(".audit-log-change > span");
    await expect(sides.nth(previous ? 0 : 2)).toContainText("Guncelleme");
    await expect(sides.nth(previous ? 2 : 0)).not.toContainText("Guncelleme");
  } finally {
    // Restore even when the save response is lost after the server commits.
    if (mutationAttempted) {
      const restored = await page.request.put(permissionsUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: { permissions: originalPermissions },
      });
      expect(restored.status()).toBe(204);
    }
  }
});
