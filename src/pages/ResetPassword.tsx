import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { apiResetPassword } from "../api/authApi";
import { ApiError } from "../api/client";
import rafLogo from "../assets/raf-logo.png";

type Phase = "checking" | "invalid" | "form" | "submitting" | "success";

function parseRecoveryToken(): string | null {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const type = params.get("type");
  const token = params.get("access_token");
  if (type === "recovery" && token) return token;
  return null;
}

export function ResetPassword() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("checking");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = parseRecoveryToken();
    // Remove the token from the address bar and browser history immediately
    // after extraction so the recovery URL cannot be replayed from history.
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (token) {
      setAccessToken(token);
      setPhase("form");
    } else {
      setPhase("invalid");
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (!accessToken) {
      setPhase("invalid");
      return;
    }

    setPhase("submitting");

    try {
      await apiResetPassword(password, accessToken);
      setPhase("success");
      setTimeout(() => navigate("/login", { replace: true }), 2500);
    } catch (err) {
      setPhase("form");
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          setPhase("invalid");
        } else {
          setError(err.message ?? "Something went wrong. Please try again.");
        }
      } else {
        setError("Something went wrong. Please try again.");
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
          {phase === "checking" && (
            <p className="text-center text-[14px] text-[var(--text-muted)]">Checking reset link…</p>
          )}

          {phase === "invalid" && (
            <div className="text-center">
              <p className="text-[16px] font-semibold text-[var(--text-strong)]">Link unavailable</p>
              <p className="mt-2 text-[14px] text-[var(--text-muted)]">
                This password reset link is invalid or has expired.
              </p>
              <Link
                to="/forgot-password"
                className="mt-5 inline-block text-[13px] font-medium hover:underline"
                style={{ color: "var(--primary-color)" }}
              >
                Request a new link
              </Link>
            </div>
          )}

          {(phase === "form" || phase === "submitting") && (
            <>
              <p className="mb-1 text-[17px] font-semibold text-[var(--text-strong)]">Set a new password</p>
              <p className="mb-5 text-[13px] text-[var(--text-muted)]">Choose a strong password for your NOMI account.</p>

              <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--text-strong)]">
                    New password
                  </label>
                  <input
                    type="password"
                    className="ui-field"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    autoFocus
                    minLength={8}
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--text-strong)]">
                    Confirm password
                  </label>
                  <input
                    type="password"
                    className="ui-field"
                    placeholder="Repeat your new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
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
                  {phase === "submitting" ? "Updating…" : "Update password"}
                </button>
              </form>
            </>
          )}

          {phase === "success" && (
            <div className="text-center">
              <p className="text-[16px] font-semibold text-[var(--text-strong)]">Password updated</p>
              <p className="mt-2 text-[14px] text-[var(--text-muted)]">
                Your password has been changed. Redirecting to sign in…
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
