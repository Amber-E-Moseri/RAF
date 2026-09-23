import { useState } from "react";
import { Link } from "react-router-dom";

import { apiForgotPassword } from "../api/authApi";
import { ApiError } from "../api/client";
import rafLogo from "../assets/raf-logo.png";

type Phase = "idle" | "submitting" | "submitted";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase("submitting");

    try {
      await apiForgotPassword(email);
      setPhase("submitted");
    } catch (err) {
      setPhase("idle");
      if (err instanceof ApiError && err.status >= 500) {
        setError("Something went wrong. Please try again.");
      } else {
        setPhase("submitted");
      }
    }
  }

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center px-4"
      style={{ background: "var(--surface-app)" }}
    >
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <img src={rafLogo} alt="NOMI" className="h-14 w-14 object-contain" />
        </div>

        <div
          className="rounded-[1.75rem] border border-[var(--border-color)] p-6 shadow-panel"
          style={{ background: "var(--surface-color)" }}
        >
          {phase === "submitted" ? (
            <div className="text-center">
              <p className="text-[16px] font-semibold text-[var(--text-strong)]">Check your email</p>
              <p className="mt-2 text-[14px] text-[var(--text-muted)]">
                If an account exists for that address, a password reset link has been sent.
              </p>
              <Link
                to="/login"
                className="mt-5 inline-block text-[13px] font-medium hover:underline"
                style={{ color: "var(--primary-color)" }}
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <p className="mb-1 text-[17px] font-semibold text-[var(--text-strong)]">Reset your password</p>
              <p className="mb-5 text-[13px] text-[var(--text-muted)]">
                Enter your email and we&apos;ll send you a reset link.
              </p>

              <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--text-strong)]">
                    Email
                  </label>
                  <input
                    type="email"
                    className="ui-field"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                  />
                </div>

                {error && (
                  <p className="rounded-[0.75rem] border border-[var(--badge-danger-ring)] bg-[var(--badge-danger-bg)] px-4 py-3 text-sm text-[var(--badge-danger-text)]">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={phase === "submitting"}
                  className="mt-1 w-full rounded-full py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
                  style={{ background: "var(--theme-primary)" }}
                >
                  {phase === "submitting" ? "Sending…" : "Send reset link"}
                </button>
              </form>

              <div className="mt-4 text-center">
                <Link
                  to="/login"
                  className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                >
                  Back to sign in
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
