import { test, expect, Page } from "@playwright/test";

/**
 * Deterministic UI flows. No AI calls here, so these are fast and stable;
 * assistant-driven behaviour lives in assistant-ui.spec.ts.
 */

async function gotoInbox(page: Page) {
  await page.goto("/inbox");
  await expect(page.getByTestId("list-title")).toBeVisible();
  // Wait for real mail to arrive; counting rows before this yields zero.
  await expect(page.getByTestId("email-row").first()).toBeVisible();
}

test("inbox loads real mail from the connected account", async ({ page }) => {
  await gotoInbox(page);
  await expect(page.getByTestId("list-title")).toHaveText(/inbox/i);
  await expect(page.getByTestId("email-row").first()).toBeVisible();
});

test("clicking a row opens that exact email in the detail view", async ({ page }) => {
  await gotoInbox(page);
  const first = page.getByTestId("email-row").first();
  const subject = (await first.getByTestId("row-subject").textContent())?.trim() ?? "";
  expect(subject).not.toBe("");

  await first.click();

  await expect(page.getByTestId("email-detail")).toBeVisible();
  await expect(page.getByTestId("detail-reply")).toBeVisible();
  // It must be the message that was clicked, not merely some detail view.
  await expect(page.getByTestId("detail-subject")).toHaveText(subject);
});

test("mailbox navigation switches the list", async ({ page }) => {
  await gotoInbox(page);
  for (const [nav, title] of [["nav-sent", /sent/i], ["nav-spam", /spam/i], ["nav-trash", /bin/i]] as const) {
    await page.getByTestId(nav).click();
    await expect(page.getByTestId("list-title")).toHaveText(title);
  }
});

test("compose requires confirmation before it will send", async ({ page }) => {
  await gotoInbox(page);
  await page.getByTestId("nav-compose").click();

  await page.getByTestId("compose-to").fill("nobody@example.com");
  await page.getByTestId("compose-subject").fill("E2E draft, not sent");
  await page.getByTestId("compose-body").fill("This draft is never confirmed.");

  await page.getByTestId("compose-send").click();

  // First click only arms the gate; nothing is sent yet.
  await expect(page.getByTestId("send-confirmation")).toBeVisible();
  await expect(page.getByTestId("confirm-send")).toBeVisible();
  // Deliberately do NOT confirm: this test must never send real mail.
});

test("deleting from the list asks for approval and cancel leaves it alone", async ({ page }) => {
  await gotoInbox(page);
  const rows = page.getByTestId("email-row");
  const before = await rows.count();
  expect(before).toBeGreaterThan(0);

  await rows.first().hover();
  await page.getByTestId("row-trash").first().click();

  await expect(page.getByTestId("pending-action-bar")).toBeVisible();
  await page.getByRole("button", { name: /cancel/i }).click();

  await expect(page.getByTestId("pending-action-bar")).toBeHidden();
  await expect(rows).toHaveCount(before);
});

test("filters narrow the list and can be cleared", async ({ page }) => {
  await gotoInbox(page);
  await page.getByTestId("filter-unread").click();

  await expect(page.getByTestId("list-title")).toHaveText(/results/i);
  await expect(page.getByTestId("active-filters")).toContainText("unread");

  await page.getByTestId("filter-unread").click();
  await expect(page.getByTestId("list-title")).toHaveText(/inbox/i);
});

test("dark mode toggles and survives a reload", async ({ page }) => {
  await gotoInbox(page);
  const html = page.locator("html");

  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveClass(/dark/);

  await page.reload();
  await expect(html).toHaveClass(/dark/);

  await page.getByTestId("theme-toggle").click();
  await expect(html).not.toHaveClass(/dark/);
});
