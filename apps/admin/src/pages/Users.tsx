import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../api";
import { useFetch } from "../hooks";
import { useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, roleLabels } from "../labels";

interface UserRow {
  id: number;
  name: string;
  role: string;
  last_login_at: string | null;
}
interface Provision {
  id?: number;
  name: string;
  role?: string;
  totp_secret: string;
  otpauth_uri: string;
}

const roleBadge: Record<string, string> = {
  admin: "bg-brand-100 text-brand-700",
  operator: "bg-blue-100 text-blue-700",
  viewer: "bg-slate-100 text-slate-600",
};

export default function Users() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, reload } = useFetch<UserRow[]>(isAdmin ? "/api/users" : null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("operator");
  const [provision, setProvision] = useState<Provision | null>(null);
  const [qrCode, setQrCode] = useState("");

  useEffect(() => {
    if (!provision?.otpauth_uri) {
      setQrCode("");
      return;
    }
    let active = true;
    QRCode.toDataURL(provision.otpauth_uri, { width: 220, margin: 1, errorCorrectionLevel: "M" })
      .then((dataUrl) => { if (active) setQrCode(dataUrl); })
      .catch(() => { if (active) setQrCode(""); });
    return () => { active = false; };
  }, [provision?.otpauth_uri]);

  if (!isAdmin)
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500 dark:border-dark-border dark:bg-dark-surface dark:text-dark-muted">
        使用者管理需要管理員權限。
      </div>
    );

  async function create() {
    if (!name) return;
    const res = await api.post<Provision>("/api/users", { name, role });
    setProvision(res);
    setName("");
    reload();
  }
  async function resetTotp(id: number, uname: string) {
    if (!confirm(`要重設 ${uname} 的 TOTP 嗎?其目前的驗證器將停止運作。`)) return;
    const res = await api.post<Provision>(`/api/users/${id}/reset-totp`);
    setProvision({ ...res, name: uname });
  }
  async function remove(id: number) {
    if (!confirm("要刪除使用者嗎?")) return;
    await api.del(`/api/users/${id}`);
    reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader title="使用者" subtitle="管理員、操作員與檢視者帳號" />

      <div className="card grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end lg:grid-cols-[1fr_auto_auto]">
        <div>
          <label className="label">名稱</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">角色</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">管理員</option>
            <option value="operator">操作員</option>
            <option value="viewer">檢視者</option>
          </select>
        </div>
        <button className="btn-primary w-full sm:w-auto" onClick={create}>
          建立
        </button>
      </div>

      {provision && (
        <div className="card animate-slide-in border-brand-200 bg-brand-50 p-4 dark:border-brand-500/30 dark:bg-brand-500/10">
          <div className="grid gap-4 sm:grid-cols-[220px_1fr] sm:items-center">
            <div className="flex min-h-[220px] items-center justify-center rounded-lg bg-white p-2 dark:bg-dark-raised">
              {qrCode ? <img src={qrCode} width="220" height="220" alt={`${provision.name} 的 TOTP QR Code`} /> : <span className="text-xs text-slate-400">產生 QR Code…</span>}
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium text-brand-700 dark:text-brand-200">
                <b>{provision.name}</b> 的 TOTP — 請用驗證器應用程式掃描 QR Code；此資料僅顯示一次。
              </div>
              <div className="text-xs text-slate-600 dark:text-dark-muted">
                無法掃描時可手動輸入密鑰：{" "}
                <code className="break-all rounded bg-white px-1.5 py-0.5 dark:bg-dark-raised dark:text-dark-text">
                  {provision.totp_secret}
                </code>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => setProvision(null)}>
                關閉
              </button>
            </div>
          </div>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[560px]">
          <thead>
            <tr>
              <th className="th">名稱</th>
              <th className="th">角色</th>
              <th className="th">最後登入</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="td font-medium">{u.name}</td>
                <td className="td">
                  <span className={`badge ${roleBadge[u.role] ?? "bg-slate-100 text-slate-600"}`}>
                    {label(roleLabels, u.role)}
                  </span>
                </td>
                <td className="td whitespace-nowrap text-xs text-slate-500">
                  {u.last_login_at ?? "從未"}
                </td>
                <td className="td space-x-3 whitespace-nowrap text-right">
                  <button
                    className="text-xs font-medium text-slate-600 hover:underline"
                    onClick={() => resetTotp(u.id, u.name)}
                  >
                    重設 TOTP
                  </button>
                  {u.id !== user?.id && (
                    <button
                      className="text-xs font-medium text-red-600 hover:underline"
                      onClick={() => remove(u.id)}
                    >
                      刪除
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.length === 0 && <EmptyRow colSpan={4}>尚無使用者。</EmptyRow>}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
