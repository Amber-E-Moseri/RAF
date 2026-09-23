import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppearanceProvider } from "./components/layout/AppearanceProvider";
import { AppLayout } from "./components/layout/AppLayout";
import { PeriodProvider } from "./components/layout/PeriodProvider";
import { RequireAuth } from "./components/layout/RequireAuth";
import { AuthProvider } from "./context/AuthContext";
import { PlanProvider } from "./context/PlanContext";
import { AcceptInvitation } from "./pages/AcceptInvitation";
import { Accounts } from "./pages/Accounts";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { AddIncome } from "./pages/AddIncome";
import { AllocationPreferences } from "./pages/AllocationPreferences";
import { Dashboard } from "./pages/Dashboard";
import { Debts } from "./pages/Debts";
import { Goals } from "./pages/Goals";
import { Login } from "./pages/Login";
import { Members } from "./pages/Members";
import { MonthlyReview } from "./pages/MonthlyReview";
import { NotFound } from "./pages/NotFound";
import { Plan } from "./pages/Plan";
import { PlanWizard } from "./pages/PlanWizard";
import { Profile } from "./pages/Profile";
import { Remi } from "./pages/Remi";
import { Reports } from "./pages/Reports";
import { Scenarios } from "./pages/Scenarios";
import { Settings } from "./pages/Settings";
import { Transactions } from "./pages/Transactions";
import { CashFlow } from "./pages/CashFlow";

export default function App() {
  return (
    <AppearanceProvider>
      <AuthProvider>
        <PeriodProvider>
          <PlanProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/invite/:token" element={<AcceptInvitation />} />
                <Route
                  path="/"
                  element={
                    <RequireAuth>
                      <AppLayout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<Navigate to="/dashboard" replace />} />

                  {/* ── 11 Canonical destinations ── */}
                  <Route path="dashboard" element={<Dashboard />} />
                  <Route path="transactions" element={<Transactions />} />
                  <Route path="plan" element={<Plan />} />
                  <Route path="cash-flow" element={<CashFlow />} />
                  <Route path="accounts" element={<Accounts />} />
                  <Route path="goals" element={<Goals />} />
                  <Route path="debts" element={<Debts />} />
                  <Route path="reports" element={<Reports />} />
                  <Route path="remi" element={<Remi />} />
                  <Route path="profile" element={<Profile />} />
                  <Route path="settings" element={<Settings />} />

                  {/* ── Supporting routes ── */}
                  <Route path="income/new" element={<AddIncome />} />
                  <Route path="members" element={<Members />} />
                  <Route path="monthly-review" element={<MonthlyReview />} />
                  <Route path="plan/preferences" element={<AllocationPreferences />} />
                  <Route path="plan-wizard" element={<PlanWizard />} />
                  <Route path="scenarios" element={<Scenarios />} />

                  {/* ── Compatibility redirects ── */}
                  <Route path="outlook" element={<Navigate to="/cash-flow" replace />} />
                  <Route path="cash-flow-forecast" element={<Navigate to="/cash-flow" replace />} />
                  <Route path="insights" element={<Navigate to="/reports" replace />} />
                  <Route path="allocation-preferences" element={<Navigate to="/plan/preferences" replace />} />
                  <Route path="appearance-settings" element={<Navigate to="/settings" replace />} />
                  <Route path="appearance" element={<Navigate to="/settings" replace />} />

                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </PlanProvider>
        </PeriodProvider>
      </AuthProvider>
    </AppearanceProvider>
  );
}
