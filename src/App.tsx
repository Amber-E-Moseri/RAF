import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppearanceProvider } from "./components/layout/AppearanceProvider";
import { AppLayout } from "./components/layout/AppLayout";
import { PeriodProvider } from "./components/layout/PeriodProvider";
import { RequireAuth } from "./components/layout/RequireAuth";
import { AuthProvider } from "./context/AuthContext";
import { PlanProvider } from "./context/PlanContext";
import { AcceptInvitation } from "./pages/AcceptInvitation";
import { AddIncome } from "./pages/AddIncome";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { Members } from "./pages/Members";
import { MonthlyReview } from "./pages/MonthlyReview";
import { NotFound } from "./pages/NotFound";
import { Outlook } from "./pages/Outlook";
import { Plan } from "./pages/Plan";
import { PlanWizard } from "./pages/PlanWizard";
import { Remi } from "./pages/Remi";
import { Scenarios } from "./pages/Scenarios";
import { Settings } from "./pages/Settings";
import { Transactions } from "./pages/Transactions";

export default function App() {
  return (
    <AppearanceProvider>
      <AuthProvider>
        <PeriodProvider>
          <PlanProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<Login />} />
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

                  {/* ── Primary navigation destinations ── */}
                  <Route path="dashboard" element={<Dashboard />} />
                  <Route path="transactions" element={<Transactions />} />
                  <Route path="plan" element={<Plan />} />
                  <Route path="outlook" element={<Outlook />} />
                  <Route path="monthly-review" element={<MonthlyReview />} />
                  <Route path="remi" element={<Remi />} />
                  <Route path="settings" element={<Settings />} />

                  {/* ── Supporting routes (still accessible, not in primary nav) ── */}
                  <Route path="income/new" element={<AddIncome />} />
                  <Route path="members" element={<Members />} />
                  <Route path="plan-wizard" element={<PlanWizard />} />
                  <Route path="scenarios" element={<Scenarios />} />

                  {/* ── Compatibility redirects — old bookmarks continue to work ── */}
                  <Route path="goals" element={<Navigate to="/plan?tab=goals" replace />} />
                  <Route path="debts" element={<Navigate to="/plan?tab=debts" replace />} />
                  <Route path="insights" element={<Navigate to="/outlook?tab=reports" replace />} />
                  <Route path="cash-flow-forecast" element={<Navigate to="/outlook" replace />} />
                  <Route path="allocation-preferences" element={<Navigate to="/plan" replace />} />
                  <Route path="appearance-settings" element={<Navigate to="/settings" replace />} />
                  <Route path="appearance" element={<Navigate to="/settings" replace />} />
                  <Route path="profile" element={<Navigate to="/settings?tab=profile" replace />} />

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
