"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/api";
import { KeyRound, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

const FIELD =
  "w-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogle = async () => {
    const url = await authApi.googleAuthUrl();
    window.location.href = url;
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.passwordLogin({
        email: email.trim(),
        password,
        imap_host: imapHost.trim() || undefined,
        smtp_host: smtpHost.trim() || undefined,
      });
      router.replace("/inbox");
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Sign-in failed. Check the email and password.");
    } finally {
      setBusy(false);
    }
  };

  const isGmail = /@(gmail|googlemail)\.com$/i.test(email.trim());

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-2">MailAI</h1>
        <p className="text-gray-500 dark:text-gray-400">Your AI-powered mail client</p>
      </div>

      <div className="w-full max-w-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm p-6 space-y-5">
        {/* Option 1: Google OAuth (test users) */}
        <div className="space-y-2">
          <button
            onClick={handleGoogle}
            className="w-full flex items-center justify-center gap-3 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2.5 hover:shadow-md transition-shadow font-medium text-gray-700 dark:text-gray-200"
            data-testid="connect-gmail"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 text-center">
            For approved test accounts (Google OAuth, unverified app).
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-gray-400">
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
          or sign in with any mailbox
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
        </div>

        {/* Option 2: email + app password (IMAP/SMTP) */}
        <form onSubmit={handlePassword} className="space-y-3" data-testid="password-login">
          <input
            type="email"
            className={FIELD}
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            data-testid="login-email"
          />
          <input
            type="password"
            className={FIELD}
            placeholder={isGmail ? "Gmail App Password" : "Password or app password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            data-testid="login-password"
          />

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            {advanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            Server settings (only for non-standard providers)
          </button>
          {advanced && (
            <div className="grid grid-cols-2 gap-2">
              <input className={FIELD} placeholder="IMAP host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
              <input className={FIELD} placeholder="SMTP host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900 rounded-md px-3 py-2" data-testid="login-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
            data-testid="login-submit"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/60 rounded-lg p-3">
          <p className="font-medium text-gray-600 dark:text-gray-300 mb-1">Gmail users: create an App Password</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Turn on 2-Step Verification in your Google Account.</li>
            <li>
              Open{" "}
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 dark:text-brand-400 underline"
              >
                myaccount.google.com/apppasswords
              </a>
              , create one named “MailAI”.
            </li>
            <li>Paste the 16-character password above.</li>
          </ol>
          <p className="mt-1.5">Passwords are encrypted at rest and never shared with the AI model.</p>
        </div>
      </div>
    </div>
  );
}
