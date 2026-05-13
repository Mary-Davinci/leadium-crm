import { ReactElement, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./layout/app-layout";
import { fetchMe, getAuthToken, getAuthUser } from "./lib/auth";
import { AnalyticsPage } from "./pages/analytics-page";
import { CallsPage } from "./pages/calls-page";
import { CallBridgePage } from "./pages/call-bridge-page";
import { CallBridgeTestPage } from "./pages/call-bridge-test-page";
import { ChatPage } from "./pages/chat-page";
import { ChangePasswordPage } from "./pages/change-password-page";
import { DashboardPage } from "./pages/dashboard-page";
import { LeadBoardPage, LegacyLeadBoardRedirect } from "./pages/leadboard-page";
import { LoginPage } from "./pages/login-page";
import { PraticaDetailPage } from "./pages/pratica-detail-page";
import { PratichePage } from "./pages/pratiche-page";
import { ProfilePage } from "./pages/profile-page";
import { UsersPage } from "./pages/users-page";

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
  );
}
