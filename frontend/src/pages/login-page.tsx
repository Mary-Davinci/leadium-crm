import { FormEvent, useState } from "react";
import { ArrowRight, Compass, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail } from "lucide-react";
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
  const [showPassword, setShowPassword] = useState(false);

  const token = getAuthToken();
  if (token) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
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
    <main className="login-page">
      <img className="login-backdrop" src="/brand/leadium-login-v1.png" alt="" fetchPriority="high" />
      <header className="login-header">
        <img className="login-crocieriamo" src="/brand/crocieriamo.png" alt="Crocieriamo" width="174" height="68" />
        <span className="login-header-label">CRM Booking Team</span>
      </header>

      <div className="login-content">
        <section className="login-story" aria-label="Leadium, il CRM Crocieriamo">
          <span className="login-eyebrow"><span /> CONNESSI, VERSO NUOVE METE</span>
          <div className="login-wordmark" aria-label="LEADIUM">LEAD<span>IUM</span><i aria-hidden="true" /></div>
          <p className="login-tagline">Ogni viaggio inizia <br />da una connessione.</p>
          <p className="login-story-note">Le persone, le opportunità, la prossima partenza.<br />Il tuo mondo Crocieriamo, in un unico spazio.</p>
        </section>

        <section className="login-access" aria-labelledby="login-title">
          <div className="login-ring-container" aria-hidden="true">
            <svg className="login-ring" viewBox="0 0 600 600" fill="none">
              <circle cx="300" cy="300" r="284" stroke="currentColor" strokeWidth="10" strokeDasharray="2 27.74" />
              <circle cx="300" cy="300" r="266" stroke="currentColor" strokeWidth=".7" />
              <circle className="login-ring-arc" cx="300" cy="300" r="266" strokeWidth="2" strokeDasharray="170 1502" strokeLinecap="round" />
              <circle cx="566" cy="300" r="4" fill="#5ad5e5" />
            </svg>
          </div>
          <div className="login-box">
            <div className="login-access-mark" aria-hidden="true"><Compass size={26} strokeWidth={1.5} /></div>
            <span className="login-form-eyebrow">IL TUO SPAZIO DI LAVORO</span>
            <h1 id="login-title">Bentornato a bordo.</h1>
            <p className="login-form-intro">Accedi a Leadium e riprendi la tua rotta.</p>
            <form onSubmit={handleSubmit} aria-busy={loading}>
              <div className="login-field">
                <label htmlFor="login-email">Email di lavoro</label>
                <div className="login-input-wrap">
                  <Mail size={17} aria-hidden="true" />
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="nome@crocieriamo.com"
                    spellCheck={false}
                    autoCapitalize="none"
                    disabled={loading}
                  />
                </div>
              </div>
              <div className="login-field">
                <label htmlFor="login-password">Password</label>
                <div className="login-input-wrap">
                  <LockKeyhole size={17} aria-hidden="true" />
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="Inserisci la tua password"
                    disabled={loading}
                  />
                  <button className="login-password-toggle" type="button" aria-label={showPassword ? "Nascondi password" : "Mostra password"} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              {error ? <div className="login-error" role="alert">{error}</div> : null}
              <button className="login-submit" type="submit" disabled={loading}>
                {loading ? <>Accesso in corso <LoaderCircle className="login-loading-icon" size={18} aria-hidden="true" /></> : <>Accedi a Leadium <ArrowRight size={18} aria-hidden="true" /></>}
              </button>
            </form>
            <p className="login-help">Hai bisogno di accedere?<br />Contatta il tuo amministratore.</p>
            <div className="login-access-footer"><LockKeyhole size={12} aria-hidden="true" /> Area riservata al team Crocieriamo</div>
          </div>
        </section>
      </div>
      <footer className="login-footer"><span>Crocieriamo <span aria-hidden="true">/</span> Leadium</span><span>Più viaggi. Più storie. Insieme.</span></footer>
    </main>
  );
}
