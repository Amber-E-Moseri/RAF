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
import { Debts } from "./pages/Debts";
import { Insights } from "./pages/Insights";
import { Login } from "./pages/Login";
import { MonthlyReview } from "./pages/MonthlyReview";
import { NotFound } from "./pages/NotFound";
import { Plan } from "./pages/Plan";
import { PlanWizard } from "./pages/PlanWizard";
import { Remi } from "./pages/Remi";
import { Scenarios } from "./pages/Scenarios";
import { Settings } from "./pages/Settings";
import { CashFlowForecast } from "./pages/CashFlowForecast";
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
                  <Route path="dashboard" element={<Dashboard />} />
                  <Route path="plan-wizard" element={<PlanWizard />} />
                  <Route path="plan" element={<Plan />} />
                  <Route path="allocation-preferences" element={<Navigate to="/plan?tab=allocations" replace />} />
                  <Route path="settings" element={<Settings />} />
                  <Route path="profile" element={<Navigate to="/settings?tab=profile" replace />} />
                  <Route path="members" element={<Navigate to="/settings?tab=household" replace />} />
                  <Route path="appearance-settings" element={<Navigate to="/settings?tab=appearance" replace />} />
                  <Route path="appearance" element={<Navigate to="/settings?tab=appearance" replace />} />
                  <Route path="income/new" element={<AddIncome />} />
                  <Route path="transactions" element={<Transactions />} />
                  <Route path="debts" element={<Debts />} />
                  <Route path="goals" element={<Navigate to="/plan?tab=goals" replace />} />
                  <Route path="cash-flow-forecast" element={<CashFlowForecast />} />
                  <Route path="monthly-review" element={<MonthlyReview />} />
                  <Route path="insights" element={<Insights />} />
                  <Route path="remi" element={<Remi />} />
                  <Route path="scenarios" element={<Scenarios />} />
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
