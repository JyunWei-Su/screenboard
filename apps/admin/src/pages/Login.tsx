import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth, type User } from "../auth";
import { IconMonitorPlay } from "../components/icons";

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
      setError("登入失敗 — 請檢查您的名稱與驗證器驗證碼。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-slate-50 to-brand-50 p-4 dark:from-dark-bg dark:via-dark-bg dark:to-dark-surface">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500 text-white shadow-lg shadow-brand-500/30">
            <IconMonitorPlay className="h-7 w-7" />
          </span>
          <div className="text-2xl font-bold tracking-tight text-slate-900 dark:text-dark-text">
            ScreenBoard
          </div>
          <div className="mt-1 text-sm text-slate-500 dark:text-dark-muted">
            數位看板管理
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-4 shadow-lg">
          <div>
            <label className="label">名稱</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </div>
          <div>
            <label className="label">驗證器驗證碼</label>
            <input
              className="input text-center text-lg tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="······"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </div>
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "登入中…" : "登入"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          使用您的名稱與驗證器應用程式中的 TOTP 驗證碼登入。
        </p>
      </div>
    </div>
  );
}
