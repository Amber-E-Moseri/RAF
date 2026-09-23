import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiLogin, apiSignup } from "../api/authApi";
import { ApiError } from "../api/client";
import rafLogo from "../assets/raf-logo.png";

type Mode = "signin" | "signup";

export function Login() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/dashboard";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [householdName, setHouseholdName] = useState("");
  // rememberMe is tracked for future persistence integration but has no current effect.
  // The checkbox state is preserved as a UX placeholder; no session/storage behavior is wired.
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setEmail("");
    setPassword("");
    setHouseholdName("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = mode === "signin"
        ? await apiLogin(email, password)
        : await apiSignup(email, password, householdName || undefined);
      setSession(session);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const isSignIn = mode === "signin";

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center px-4"
      style={{ background: "var(--surface-app)" }}
    >
      <div className="w-full max-w-sm">
        {/* Card */}
        <div
          className="rounded-2xl border border-[var(--border-color)] p-7 shadow-lg"
          style={{ background: "var(--surface-color)" }}
        >
          {/* Brand header */}
          <div className="mb-6 flex flex-col items-center gap-1.5">
            <div className="flex items-center gap-2">
              <img src={rafLogo} alt="NOMI" className="h-9 w-9 object-contain" />
              <span
                className="text-[20px] font-[900] tracking-[-0.02em]"
                style={{ color: "var(--text-strong)" }}
              >
                NOMI
              </span>
            </div>
            <h1
              className="mt-2 text-[24px] font-[900] tracking-[-0.03em]"
              style={{ color: "var(--text-strong)" }}
            >
              {isSignIn ? "Welcome back" : "Create account"}
            </h1>
            <p className="text-center text-[13px] text-[var(--text-muted)]">
              {isSignIn
                ? "Sign in to your NOMI account to manage your finances."
                : "Set up your household to get started."}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {!isSignIn && (
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-[var(--text-strong)]">
                  Household name
                </label>
                <input
                  type="text"
                  className="ui-field"
                  placeholder="My Household"
                  value={householdName}
                  onChange={(e) => setHouseholdName(e.target.value)}
                  autoComplete="organization"
                  autoFocus={!isSignIn}
                />
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-[var(--text-strong)]">
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
                autoFocus={isSignIn}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-[var(--text-strong)]">
                Password
              </label>
              <input
                type="password"
                className="ui-field"
                placeholder={isSignIn ? "••••••••" : "At least 8 characters"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={isSignIn ? "current-password" : "new-password"}
              />
            </div>

            {isSignIn && (
              <div className="flex items-center justify-between">
                <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-[var(--text-muted)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-[var(--border-color)]"
                    style={{ accentColor: "var(--theme-primary)" }}
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                  />
                  Remember me
                </label>
                <Link
                  to="/forgot-password"
                  className="text-[13px] font-semibold hover:underline"
                  style={{ color: "var(--theme-primary)" }}
                >
                  Forgot password?
                </Link>
              </div>
            )}

            {error && (
              <p className="rounded-xl border border-[var(--badge-danger-ring)] bg-[var(--badge-danger-bg)] px-4 py-3 text-[13px] text-[var(--badge-danger-text)]">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-1 w-full rounded-full py-3 text-[14px] font-[800] text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--theme-primary)" }}
            >
              {loading
                ? (isSignIn ? "Signing in…" : "Creating account…")
                : (isSignIn ? "Sign in" : "Create account")}
            </button>
          </form>

          {/* Switch mode */}
          <p className="mt-5 text-center text-[13px] text-[var(--text-muted)]">
            {isSignIn ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signup")}
                  className="font-[800] transition hover:opacity-75"
                  style={{ color: "var(--theme-primary)" }}
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signin")}
                  className="font-[800] transition hover:opacity-75"
                  style={{ color: "var(--theme-primary)" }}
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
