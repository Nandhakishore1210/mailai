import { test, expect, Page } from "@playwright/test";

/**
 * The headline requirement: the assistant drives the visible UI, it does not
 * merely reply in chat. Each test asserts that the MAIN interface changed.
 *
 * These make real model calls, so they are slower and cost a little. They are
 * kept few and high-value for that reason.
 */

test.describe.configure({ mode: "serial" });

async function openAssistant(page: Page) {
  await page.goto("/inbox");
  await expect(page.getByTestId("list-title")).toBeVisible();
  const toggle = page.getByTestId("assistant-toggle");
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await expect(page.getByTestId("assistant-input")).toBeVisible();
}

async function ask(page: Page, message: string) {
  await page.getByTestId("assistant-input").fill(message);
  await page.getByTestId("assistant-send").click();
}

test("natural language fills the compose form visibly", async ({ page }) => {
  await openAssistant(page);
  await ask(page, "Send an email to john@example.com with subject 'Meeting Tomorrow' and body 'Let us meet at 3pm'");

  await expect(page.getByTestId("compose-form")).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId("compose-to")).toHaveValue(/john@example\.com/);
  await expect(page.getByTestId("compose-subject")).toHaveValue(/meeting tomorrow/i);
  await expect(page.getByTestId("compose-body")).not.toHaveValue("");

  // Human-in-the-loop: it must ask, never send by itself.
  await expect(page.getByTestId("send-confirmation")).toBeVisible();
});

test("a filter request updates the main list, not just the chat", async ({ page }) => {
  await openAssistant(page);
  await ask(page, "Show only unread emails from this week");

  await expect(page.getByTestId("list-title")).toHaveText(/results/i, { timeout: 40_000 });
  await expect(page.getByTestId("active-filters")).toContainText("unread");
});

test("it opens a specific email in the detail view", async ({ page }) => {
  await openAssistant(page);
  await ask(page, "Open the most recent email in my inbox");

  await expect(page.getByTestId("email-detail")).toBeVisible({ timeout: 40_000 });
});

test("'reply to this' uses the email that is currently open", async ({ page }) => {
  await page.goto("/inbox");
  await page.getByTestId("email-row").first().click();
  await expect(page.getByTestId("email-detail")).toBeVisible();

  const toggle = page.getByTestId("assistant-toggle");
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await ask(page, "Reply to this saying I will follow up tomorrow");

  await expect(page.getByTestId("compose-form")).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId("compose-body")).toHaveValue(/tomorrow/i);
  // A reply keeps the original recipient, so the To field is locked.
  await expect(page.getByTestId("compose-to")).toBeDisabled();
});

test("'reply to this' with nothing open asks instead of guessing", async ({ page }) => {
  await openAssistant(page);
  await ask(page, "Reply to this");

  // It must not invent a target and open a draft.
  await page.waitForTimeout(25_000);
  await expect(page.getByTestId("compose-form")).toBeHidden();
  await expect(page.getByTestId("assistant-message").last()).toBeVisible();
});
