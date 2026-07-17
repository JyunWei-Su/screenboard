import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth, type User } from "../auth";

export default function Login() {
  const { login } = useAuth();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await api.post<{ token: string; user: User }>("/api/auth/login", {
        name,
        code,
      });
      login(res.token, res.user);
    } catch {
      setError("Login failed — check your name and authenticator code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100">
      <form onSubmit={submit} className="card w-80 space-y-4">
        <div className="text-center">
          <div className="text-2xl font-bold text-brand-600">ScreenBoard</div>
          <div className="mt-1 text-sm text-slate-500">Sign in with your TOTP code</div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Authenticator code
          </label>
          <input
            className="input tracking-widest"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            inputMode="numeric"
          />
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
