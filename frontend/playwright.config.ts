import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a REAL running app: the Next.js frontend on
 * :3000, the FastAPI backend on :8000, and a real connected mailbox.
 *
 * Specs live in ./e2e inside this package, so they resolve @playwright/test
 * from the same node_modules Playwright itself runs from.
 *
 * Authentication is injected rather than performed, since signing in for real
 * means driving Google's consent screen. ./e2e/global-setup.ts turns
 * MAILAI_SESSION_TOKEN into a browser cookie. Mint one with:
 *
 *   cd backend
 *   .venv/Scripts/python -c "from app.auth.sessions import create_session_token; \
 *       from app.db.session import SessionLocal; from app.db.models import User; \
 *       db=SessionLocal(); print(create_session_token(db.query(User).first().id))"
 *
 * Then:  MAILAI_SESSION_TOKEN=<token> npm run test:e2e
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // one mailbox, so tests must not race each other
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    storageState: "./e2e/.auth/state.json",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
