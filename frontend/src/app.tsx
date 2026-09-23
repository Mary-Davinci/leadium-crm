import { ReactElement, Suspense, lazy, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./layout/app-layout";
import { PageState } from "./components/ui/page-state";
import { fetchMe, getAuthToken, getAuthUser } from "./lib/auth";
import { CallsPage } from "./pages/calls-page";
import { CallBridgePage } from "./pages/call-bridge-page";
import { CallBridgeTestPage } from "./pages/call-bridge-test-page";
import { LoginPage } from "./pages/login-page";

const DashboardPage = lazy(() => import("./pages/dashboard-page").then((module) => ({ default: module.DashboardPage })));
const PratichePage = lazy(() => import("./pages/pratiche-page").then((module) => ({ default: module.PratichePage })));
const PraticaDetailPage = lazy(() => import("./pages/pratica-detail-page").then((module) => ({ default: module.PraticaDetailPage })));
const CustomerDetailPage = lazy(() => import("./pages/customer-detail-page").then((module) => ({ default: module.CustomerDetailPage })));
const LeadImportPage = lazy(() => import("./pages/lead-import-page").then((module) => ({ default: module.LeadImportPage })));
const LeadBoardPage = lazy(() => import("./pages/leadboard-page").then((module) => ({ default: module.LeadBoardPage })));
const LegacyLeadBoardRedirect = lazy(() =>
  import("./pages/leadboard-page").then((module) => ({ default: module.LegacyLeadBoardRedirect }))
);
const ChatPage = lazy(() => import("./pages/chat-page").then((module) => ({ default: module.ChatPage })));
const AnalyticsPage = lazy(() => import("./pages/analytics-page").then((module) => ({ default: module.AnalyticsPage })));
const BookingReportPage = lazy(() => import("./pages/booking-report-page").then((module) => ({ default: module.BookingReportPage })));
const MarketingReportPage = lazy(() => import("./pages/marketing-report-page").then((module) => ({ default: module.MarketingReportPage })));
const ProfilePage = lazy(() => import("./pages/profile-page").then((module) => ({ default: module.ProfilePage })));
const ChangePasswordPage = lazy(() =>
  import("./pages/change-password-page").then((module) => ({ default: module.ChangePasswordPage }))
);
const UsersPage = lazy(() => import("./pages/users-page").then((module) => ({ default: module.UsersPage })));

function RequireAuth({ children }: { children: ReactElement }) {
  const token = getAuthToken();
  const [checking, setChecking] = useState(true);
  const [isValid, setIsValid] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function verifySession() {
      if (!token) {
        if (mounted) {
          setIsValid(false);
          setChecking(false);
        }
        return;
      }
      const user = await fetchMe();
      if (mounted) {
        setIsValid(Boolean(user));
        setChecking(false);
      }
    }
    verifySession().catch(() => {
      if (mounted) {
        setIsValid(false);
        setChecking(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [token]);

  if (checking) return <div className="muted">Verifica sessione...</div>;
  if (!token || !isValid) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }: { children: ReactElement }) {
  const user = getAuthUser();
  if (!user || (user.role !== "admin" && user.role !== "super_admin")) return <Navigate to="/dashboard" replace />;
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<PageState kind="loading" title="Caricamento area di lavoro" />}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/calls/bridge" element={<CallBridgePage />} />
        <Route path="/calls/bridge/test" element={<CallBridgeTestPage />} />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/pratiche" element={<PratichePage />} />
          <Route path="/pratiche/:id" element={<PraticaDetailPage />} />
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
          <Route
            path="/tasks/import"
            element={
              <RequireAdmin>
                <LeadImportPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/tasks"
            element={
              <RequireAdmin>
                <LeadBoardPage />
              </RequireAdmin>
            }
          />
          <Route path="/leadboard" element={<LegacyLeadBoardRedirect />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/calls" element={<CallsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route
            path="/reports/booking-activities"
            element={
              <RequireAdmin>
                <BookingReportPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/reports/marketing"
            element={
              <RequireAdmin>
                <MarketingReportPage />
              </RequireAdmin>
            }
          />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route
            path="/users"
            element={
              <RequireAdmin>
                <UsersPage />
              </RequireAdmin>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  );
}
