import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { getAuthToken, login } from "../lib/auth";
import "../styles/login-page.css";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const token = getAuthToken();
  if (token) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(email.trim(), password.trim());
      const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || "/dashboard";
      navigate(from, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Errore login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-ring-container">
        {Array.from({ length: 50 }).map((_, idx) => (
          <span key={idx} style={{ ["--i" as string]: idx + 1 }} />
        ))}
        <div className="login-box">
          <form onSubmit={handleSubmit}>
            <h2>Login</h2>
            <div className="input-box">
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder=" "
              />
              <label htmlFor="login-email">Email</label>
            </div>
            <div className="input-box">
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder=" "
              />
              <label htmlFor="login-password">Password</label>
            </div>
            {error ? <div className="login-error">{error}</div> : null}
            <div className="forgot-pass">
              <a href="#" onClick={(e) => e.preventDefault()}>
                Accesso portale Leadium
              </a>
            </div>
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Accesso..." : "Accedi"}
            </button>
            <div className="signup-link">
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
