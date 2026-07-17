import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { useAuth } from "../auth";

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

export default function Users() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, reload } = useFetch<UserRow[]>(isAdmin ? "/api/users" : null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("operator");
  const [provision, setProvision] = useState<Provision | null>(null);

  if (!isAdmin) return <div className="text-slate-500">User management requires the admin role.</div>;

  async function create() {
    if (!name) return;
    const res = await api.post<Provision>("/api/users", { name, role });
    setProvision(res);
    setName("");
    reload();
  }
  async function resetTotp(id: number, uname: string) {
    if (!confirm(`Reset TOTP for ${uname}? Their current authenticator will stop working.`)) return;
    const res = await api.post<Provision>(`/api/users/${id}/reset-totp`);
    setProvision({ ...res, name: uname });
  }
  async function remove(id: number) {
    if (!confirm("Delete user?")) return;
    await api.del(`/api/users/${id}`);
    reload();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>

      <div className="card flex flex-wrap items-end gap-3">
        <div className="grow">
          <label className="mb-1 block text-xs text-slate-500">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">Role</label>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">admin</option>
            <option value="operator">operator</option>
            <option value="viewer">viewer</option>
          </select>
        </div>
        <button className="btn-primary" onClick={create}>Create</button>
      </div>

      {provision && (
        <div className="card space-y-2 bg-brand-50">
          <div className="text-sm font-medium text-brand-700">
            TOTP for <b>{provision.name}</b> — shown once. Add it to an authenticator app now.
          </div>
          <div className="text-xs text-slate-600">
            Secret: <code className="rounded bg-white px-1">{provision.totp_secret}</code>
          </div>
          <div className="break-all text-xs text-slate-500">{provision.otpauth_uri}</div>
          <button className="btn-ghost" onClick={() => setProvision(null)}>Dismiss</button>
        </div>
      )}

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th">Role</th>
              <th className="th">Last login</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="td font-medium">{u.name}</td>
                <td className="td">{u.role}</td>
                <td className="td text-xs text-slate-500">{u.last_login_at ?? "never"}</td>
                <td className="td space-x-3 text-right">
                  <button className="text-xs text-slate-600 hover:underline" onClick={() => resetTotp(u.id, u.name)}>Reset TOTP</button>
                  {u.id !== user?.id && (
                    <button className="text-xs text-red-600 hover:underline" onClick={() => remove(u.id)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
