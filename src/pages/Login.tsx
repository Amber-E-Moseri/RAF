import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiLogin, apiSignup } from "../api/authApi";
import { ApiError } from "../api/client";
import rafLogo from "../assets/raf-logo.png";

type Mode = "login" | "signup";

export function Login() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/dashboard";

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session =
        mode === "login"
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

  const isLogin = mode === "login";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4" style={{ background: "#f0ece6" }}>
      <div className="w-full max-w-[360px]">
        <div className="rounded-[1.75rem] bg-white p-8 shadow-[0_8px_40px_rgba(0,0,0,0.10)]">

          {/* Brand header */}
          <div className="mb-6 flex flex-col items-center gap-1.5">
            <div className="flex items-center justify-center">
              <img src={rafLogo} alt="RAF" className="h-12 w-12 object-contain" />
            </div>
            <h1 className="mt-2 text-[24px] font-[900] tracking-[-0.03em] text-[#111]">
              {isLogin ? "Welcome back" : "Create account"}
            </h1>
            <p className="text-center text-[13px] text-[#667085]">
              {isLogin
                ? <>Sign in to your NOMI account{" "}<span style={{ color: "var(--theme-primary)" }}>to manage your finances.</span></>
                : "Set up your household to get started."}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {!isLogin && (
              <div>
                <label className="mb-1.5 block text-[12px] font-[700] text-[#111]">
                  Household name
                </label>
                <input
                  type="text"
                  className="ui-field"
                  placeholder="My Household"
                  value={householdName}
                  onChange={(e) => setHouseholdName(e.target.value)}
                  autoComplete="organization"
                />
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-[12px] font-[700] text-[#111]">
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

            <div>
              <label className="mb-1.5 block text-[12px] font-[700] text-[#111]">
                Password
              </label>
              <input
                type="password"
                className="ui-field"
                placeholder={isLogin ? "••••••••" : "At least 8 characters"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={isLogin ? "current-password" : "new-password"}
              />
            </div>

            {/* Remember me + forgot */}
            {isLogin && (
              <div className="flex items-center justify-between">
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[#667085]">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 rounded border-[#d4d8d4]"
                  />
                  Remember me
                </label>
                <button
                  type="button"
                  className="text-[13px] font-[700] transition hover:opacity-75"
                  style={{ color: "var(--theme-primary)" }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            {error && (
              <p className="rounded-[0.75rem] border border-[#fecaca] bg-[#fff0f0] px-4 py-3 text-[13px] text-[#c84848]">
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
                ? (isLogin ? "Signing in…" : "Creating account…")
                : (isLogin ? "Sign in" : "Create account")}
            </button>
          </form>

          {/* Switch mode */}
          <p className="mt-5 text-center text-[13px] text-[#667085]">
            {isLogin ? (
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
                  onClick={() => switchMode("login")}
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
