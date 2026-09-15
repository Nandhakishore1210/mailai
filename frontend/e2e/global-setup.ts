import fs from "fs";
import path from "path";

/**
 * Writes a Playwright storageState containing the session cookie, so tests
 * start already signed in. Signing in for real would mean driving Google's
 * consent screen, which is not something a test should do.
 */
export default async function globalSetup() {
  const token = process.env.MAILAI_SESSION_TOKEN;
  if (!token) {
    throw new Error(
      "MAILAI_SESSION_TOKEN is not set. These tests need a signed-in session.\n" +
        "See the comment at the top of playwright.config.ts for how to mint one."
    );
  }

  const dir = path.join(__dirname, ".auth");
  fs.mkdirSync(dir, { recursive: true });

  const state = {
    cookies: [
      {
        name: "session_token",
        value: token,
        domain: "localhost",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };

  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
}
