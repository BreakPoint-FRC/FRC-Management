import { test, expect, type Page } from "@playwright/test";

const permission = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };
const stay = "Düzenlemeye devam et";
const discard = "Değişiklikleri sil ve devam et";
const report = (page: Page) => page.locator("form textarea");
const cancel = (page: Page) => page.getByRole("button", { name: "İptal", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Kaydedilmemiş değişiklikler", exact: true });

async function setup(page: Page) {
  const rows = ["Alpha", "Beta"].map((title, index) => ({
    id: String(index + 1), title, body: `${title} report`, meetingDate: "2026-09-12T12:00:00Z",
    groupId: null, groupName: null, createdBy: { id: "actor", fullName: "Editor" },
    attendance: [], attendedCount: 0,
  }));
  let writes = 0;
  let logouts = 0;
  await page.route("http://localhost:4100/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/login") return route.fulfill({ json: { accessToken: "test", refreshToken: "test" } });
    if (path === "/auth/logout") { logouts++; return route.fulfill({ status: 204 }); }
    if (path === "/auth/me") return route.fulfill({ json: {
      account: { id: "actor", fullName: "Editor", email: "editor@example.test", teamId: "team", mustChangePassword: false },
      team: { id: "team", name: "Test", setupStage: "DONE" }, roles: [],
      groups: [{ id: "group", name: "Software" }],
      permissions: { global: { MEETINGS: permission }, byGroup: {} },
    } });
    if (path.endsWith("/attendance-candidates")) return route.fulfill({ json: [] });
    if (path.startsWith("/meetings") && ["PATCH", "POST"].includes(route.request().method())) {
      writes++;
      const body = route.request().postDataJSON();
      if (route.request().method() === "POST") rows.push({ ...rows[0], ...body, id: "3" });
      else Object.assign(rows.find((row) => path === `/meetings/${row.id}`)!, body);
      return route.fulfill({ json: { ...rows[0], ...body } });
    }
    if (path === "/meetings") return route.fulfill({ json: { items: rows, page: 1, pageSize: 100, total: rows.length, totalPages: 1 } });
    if (path.startsWith("/meetings/")) return route.fulfill({ json: rows.find((row) => path === `/meetings/${row.id}`) });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/login");
  await page.getByLabel("E-posta").fill("editor@example.test");
  await page.getByLabel("Sifre", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Giris yap", exact: true }).click();
  await page.getByRole("link", { name: "Toplantilar", exact: true }).click();
  await page.getByRole("button", { name: "Duzenle", exact: true }).first().click();
  await expect(report(page)).toHaveValue("Alpha report");
  return { writes: () => writes, logouts: () => logouts };
}

test("native warning on reload preserves the draft when dismissed", async ({ page }) => {
  await setup(page);
  await report(page).fill("Unsaved report");
  const warning = page.waitForEvent("dialog");
  await page.evaluate(() => { setTimeout(() => window.location.reload(), 0); });
  const native = await warning;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(report(page)).toHaveValue("Unsaved report");
  await expect(dialog(page)).toHaveCount(0);
  // Leave a clean page for browser-context teardown after cancelling a native unload.
  await cancel(page).click();
  await page.getByRole("button", { name: discard }).click();
});

test("native warning on tab close supports staying and leaving", async ({ page }) => {
  await setup(page);
  // Keep a window alive while testing tab closure (also avoids Firefox's
  // session-store teardown race when its last tab has shown beforeunload).
  await page.context().newPage();
  await page.bringToFront();
  await report(page).fill("Unsaved report");
  const warning = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const native = await warning;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await expect(report(page)).toHaveValue("Unsaved report");
  const secondWarning = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const closed = page.waitForEvent("close");
  await (await secondWarning).accept();
  await closed;
});

for (const action of ["cancel", "edit", "create", "detail", "menu", "logout"] as const) {
  test(`custom dialog guards ${action} without a browser confirm`, async ({ page }) => {
    const calls = await setup(page);
    const nativeDialogs: string[] = [];
    page.on("dialog", async (event) => { nativeDialogs.push(event.type()); await event.dismiss(); });
    await report(page).fill("Unsaved report");
    const trigger = action === "cancel" ? cancel(page)
      : action === "edit" ? page.getByRole("button", { name: "Duzenle", exact: true }).nth(1)
      : action === "create" ? page.getByRole("button", { name: "+ Yeni toplanti", exact: true })
      : action === "detail" ? page.getByRole("link", { name: "Beta", exact: true })
      : action === "menu" ? page.getByRole("link", { name: "Genel bakis", exact: true })
      : page.getByRole("button", { name: "Cikis yap", exact: true });
    await trigger.click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByRole("button", { name: stay })).toBeFocused();
    await expect(page).toHaveURL(/\/meetings$/);
    expect(calls.logouts()).toBe(0);
    await page.getByRole("button", { name: stay }).click();
    await expect(report(page)).toHaveValue("Unsaved report");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("button", { name: discard }).click();
    await expect(dialog(page)).toHaveCount(0);
    if (action === "edit" || action === "create") {
      await expect(report(page)).toHaveValue(action === "edit" ? "Beta report" : "");
      await cancel(page).click();
      await expect(report(page)).toHaveCount(0);
    } else if (action === "detail") await expect(page).toHaveURL(/\/meetings\/2$/);
    else if (action === "menu") await expect(page).toHaveURL("/");
    else if (action === "logout") { await expect(page).toHaveURL(/\/login$/); expect(calls.logouts()).toBe(1); }
    else await expect(report(page)).toHaveCount(0);
    expect(nativeDialogs).toEqual([]);
    expect(calls.writes()).toBe(0);
  });
}

test("keyboard focus remains in the modal and Escape preserves the draft", async ({ page }) => {
  await setup(page);
  await report(page).fill("Unsaved report");
  await cancel(page).click();
  await expect(page.getByRole("button", { name: stay })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: discard })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: stay })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(cancel(page)).toBeFocused();
  await expect(report(page)).toHaveValue("Unsaved report");
});

test("every field is guarded and reverting all changes makes the form clean", async ({ page }) => {
  await setup(page);
  const fields = [page.locator('form input[type="text"]'), page.locator('form input[type="date"]'), page.locator("form select"), report(page)];
  const changed = ["Changed title", "2026-09-13", "group", "Changed report"];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const original = await field.inputValue();
    if (index === 2) await field.selectOption(changed[index]); else await field.fill(changed[index]);
    await cancel(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    if (index === 2) await field.selectOption(original); else await field.fill(original);
  }
  await cancel(page).click();
  await expect(report(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  const nativeDialogs: string[] = [];
  page.on("dialog", async (event) => { nativeDialogs.push(event.type()); await event.accept(); });
  await page.reload();
  expect(nativeDialogs).toEqual([]);
});

for (const mode of ["edit", "create"] as const) {
  test(`successful ${mode} immediately clears both guards`, async ({ page }) => {
    const calls = await setup(page);
    if (mode === "create") {
      await page.getByRole("button", { name: "+ Yeni toplanti", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await page.locator('form input[type="text"]').fill("Created meeting");
    }
    await report(page).fill("Saved update");
    await page.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(report(page)).toHaveCount(0);
    expect(calls.writes()).toBe(1);
    await page.getByRole("row").filter({ has: page.getByRole("link", { name: mode === "edit" ? "Alpha" : "Created meeting", exact: true }) }).getByRole("button", { name: "Duzenle" }).click();
    await expect(report(page)).toHaveValue("Saved update");
    await cancel(page).click();
    await expect(report(page)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    const nativeDialogs: string[] = [];
    page.on("dialog", async (event) => { nativeDialogs.push(event.type()); await event.accept(); });
    await page.reload();
    expect(nativeDialogs).toEqual([]);
  });
}

for (const mode of ["edit", "create"] as const) for (const exit of ["reload", "close"] as const) {
  test(`${mode} then immediate ${exit} has no native warning`, async ({ page }) => {
    await setup(page);
    if (mode === "create") {
      await page.getByRole("button", { name: "+ Yeni toplanti", exact: true }).click();
      await page.locator('form input[type="text"]').fill("Created meeting");
    }
    await report(page).fill("Saved update");
    const warnings: string[] = [];
    page.on("dialog", async (event) => { warnings.push(event.type()); await event.accept(); });
    await page.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(report(page)).toHaveCount(0);
    if (exit === "reload") await page.reload();
    else {
      const closed = page.waitForEvent("close");
      await page.close({ runBeforeUnload: true });
      await closed;
    }
    expect(warnings).toEqual([]);
  });
}

test("pending and failed saves preserve the draft and the browser protection", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/meetings/1", async (route) => {
    await pending;
    await route.fulfill({ status: 500, json: { message: "Save failed" } });
  });
  await report(page).fill("Unsaved report");
  await page.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(report(page)).toBeDisabled();
  await expect(cancel(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Duzenle" }).first()).toBeDisabled();
  await page.getByRole("link", { name: "Beta", exact: true }).click();
  await page.getByRole("link", { name: "Genel bakis", exact: true }).click();
  await page.getByRole("button", { name: "Cikis yap", exact: true }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(dialog(page)).toHaveCount(0);
  const warning = page.waitForEvent("dialog");
  await page.evaluate(() => { setTimeout(() => window.location.reload(), 0); });
  const native = await warning;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  release();
  await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
  await expect(report(page)).toBeEnabled();
  await expect(report(page)).toHaveValue("Unsaved report");
  const failedSaveWarning = page.waitForEvent("dialog");
  await page.evaluate(() => { setTimeout(() => window.location.reload(), 0); });
  const afterFailure = await failedSaveWarning;
  expect(afterFailure.type()).toBe("beforeunload");
  await afterFailure.dismiss();
  await cancel(page).click();
  await expect(dialog(page)).toBeVisible();
});

test("filtering and new-tab gestures preserve the current draft without a dialog", async ({ page }) => {
  await setup(page);
  await report(page).fill("Unsaved report");
  await page.locator("main > .row select").selectOption("group");
  await expect(report(page)).toHaveValue("Unsaved report");
  // Check the browser's default action is left intact without depending on
  // headless Chromium opening a background tab for a modifier click.
  await page.evaluate(() => {
    document.addEventListener("click", (event) => {
      document.documentElement.dataset.modifierPrevented = String(event.defaultPrevented);
    }, { once: true });
  });
  await page.getByRole("link", { name: "Beta", exact: true }).dispatchEvent("click", { ctrlKey: true, button: 0 });
  await expect(page.locator("html")).toHaveAttribute("data-modifier-prevented", "false");
  await expect(dialog(page)).toHaveCount(0);
  await expect(report(page)).toHaveValue("Unsaved report");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`dialog fits a mobile viewport in ${colorScheme} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.emulateMedia({ colorScheme });
    await setup(page);
    await report(page).fill("Unsaved report");
    await cancel(page).click();
    await expect(page.getByRole("button", { name: stay })).toBeInViewport();
    await expect(page.getByRole("button", { name: discard })).toBeInViewport();
    expect(await dialog(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("unsaved-dialog.png") });
  });
}
