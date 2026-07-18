import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { PageHeader } from "../components/ui";
import { useToast } from "../toast";
import UsersSettings from "./Users";

interface SshAccessSettings {
  emails: string[];
  configured: boolean;
}

interface OrphanTunnel {
  id: string;
  name: string;
  status: string;
  created_at: string | null;
}

interface TunnelsSettings {
  configured: boolean;
  orphans: OrphanTunnel[];
  in_use: number;
}

type TabKey = "users" | "ssh" | "tunnels";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-brand-500 text-brand-700 dark:border-brand-400 dark:text-brand-200"
          : "border-transparent text-slate-500 hover:text-slate-800 dark:text-dark-muted dark:hover:text-dark-text"
      }`}
    >
      {children}
    </button>
  );
}

function SshAccessSection() {
  const { user } = useAuth();
  const writable = canWrite(user) && user?.role === "admin";
  const { showToast } = useToast();
  const { data, reload } = useFetch<SshAccessSettings>("/api/settings/ssh-access");
  const [emails, setEmails] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setEmails(data.emails.length ? data.emails : [""]);
  }, [data]);

  function updateEmail(index: number, value: string) {
    setEmails((prev) => prev.map((email, i) => (i === index ? value : email)));
  }

  function addEmail() {
    setEmails((prev) => [...prev, ""]);
  }

  function removeEmail(index: number) {
    setEmails((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length ? next : [""];
    });
  }

  async function save() {
    const values = [...new Set(emails.map((email) => email.trim()).filter(Boolean))];
    setBusy(true);
    try {
      const result = await api.put<{ emails: string[] }>("/api/settings/ssh-access", { emails: values });
      setEmails(result.emails.length ? result.emails : [""]);
      showToast("已儲存。裝置下次按「修復 SSH」時會自動套用。", "success");
      reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "儲存失敗", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="card-title">SSH Access 允許信箱</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-dark-muted">
          每個欄位填一個信箱。儲存後不需要重新部署；請於裝置頁按「佈建／重新佈建 SSH」套用至既有 Tunnel。
        </p>
      </div>
      {!data?.configured && <p className="text-sm text-amber-600">Cloudflare SSH 遠端存取尚未完成設定。</p>}

      <div className="space-y-2">
        {emails.map((email, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="email"
              className="input flex-1"
              value={email}
              disabled={!writable || busy}
              placeholder="ops@example.com"
              onChange={(event) => updateEmail(index, event.target.value)}
            />
            {writable && (
              <button
                type="button"
                className="btn-ghost btn-sm shrink-0"
                disabled={busy || (emails.length === 1 && !email)}
                onClick={() => removeEmail(index)}
                aria-label="移除信箱"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {writable ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={addEmail}>
            ＋ 新增信箱
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "儲存中…" : "儲存設定"}
          </button>
        </div>
      ) : (
        <p className="text-sm text-slate-400">僅管理員可修改此設定。</p>
      )}
    </section>
  );
}

function TunnelCleanupSection() {
  const { user } = useAuth();
  const writable = canWrite(user) && user?.role === "admin";
  const { showToast } = useToast();
  const { data, loading, reload } = useFetch<TunnelsSettings>("/api/settings/tunnels");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const orphans = data?.orphans ?? [];
  const allSelected = orphans.length > 0 && orphans.every((t) => selected.has(t.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(orphans.map((t) => t.id)));
  }

  async function cleanup(ids: string[]) {
    if (!ids.length) return;
    if (!confirm(`要刪除 ${ids.length} 個非使用中的 Tunnel 嗎？此操作無法復原。`)) return;
    setBusy(true);
    try {
      const result = await api.post<{ deleted: string[]; failed: { id: string; error: string }[] }>(
        "/api/settings/tunnels/cleanup",
        { ids },
      );
      const message = result.failed.length
        ? `已刪除 ${result.deleted.length} 個，${result.failed.length} 個失敗`
        : `已刪除 ${result.deleted.length} 個 Tunnel`;
      showToast(message, result.failed.length ? "error" : "success");
      setSelected(new Set());
      reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "清除失敗", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="card-title">非使用中的 Tunnel</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-dark-muted">
          重新佈建 SSH 時會建立新的 Cloudflare Tunnel，舊的若仍有連線便無法自動刪除而殘留。
          這裡列出沒有任何裝置在使用的 ScreenBoard Tunnel，可安全手動清除。
        </p>
      </div>

      {!data?.configured && <p className="text-sm text-amber-600">Cloudflare SSH 遠端存取尚未完成設定。</p>}

      {data?.configured && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500 dark:text-dark-muted">
            <span>使用中 {data.in_use} 個 · 非使用中 {orphans.length} 個</span>
            <button className="btn-ghost btn-sm" disabled={busy || loading} onClick={() => reload()}>
              重新整理
            </button>
          </div>

          {loading && !data ? (
            <p className="text-sm text-slate-400">載入中…</p>
          ) : orphans.length === 0 ? (
            <p className="text-sm text-slate-400">沒有非使用中的 Tunnel。</p>
          ) : (
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-dark-border dark:border-dark-border">
              <label className="flex items-center gap-3 px-3 py-2 text-sm font-medium">
                <input type="checkbox" checked={allSelected} disabled={!writable || busy} onChange={toggleAll} />
                全選
              </label>
              {orphans.map((t) => (
                <label key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    disabled={!writable || busy}
                    onChange={() => toggle(t.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-mono text-xs text-slate-600 dark:text-dark-text">{t.name}</span>
                    <span className="text-xs text-slate-400">
                      {t.status}
                      {t.created_at ? ` · 建立於 ${new Date(t.created_at).toLocaleString()}` : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {writable ? (
            orphans.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-danger"
                  disabled={busy || selected.size === 0}
                  onClick={() => void cleanup([...selected])}
                >
                  {busy ? "清除中…" : `清除選取（${selected.size}）`}
                </button>
                <button
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => void cleanup(orphans.map((t) => t.id))}
                >
                  清除全部
                </button>
              </div>
            )
          ) : (
            <p className="text-sm text-slate-400">僅管理員可清除 Tunnel。</p>
          )}
        </>
      )}
    </section>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState<TabKey>(isAdmin ? "users" : "ssh");

  return (
    <div className="space-y-5">
      <PageHeader title="系統設定" subtitle="管理帳號、Cloudflare Access 與 SSH 的執行期設定。" />

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-dark-border">
        {isAdmin && (
          <TabButton active={tab === "users"} onClick={() => setTab("users")}>
            使用者
          </TabButton>
        )}
        <TabButton active={tab === "ssh"} onClick={() => setTab("ssh")}>
          SSH Access
        </TabButton>
        {isAdmin && (
          <TabButton active={tab === "tunnels"} onClick={() => setTab("tunnels")}>
            Tunnel 清理
          </TabButton>
        )}
      </div>

      {tab === "users" && isAdmin && <UsersSettings />}
      {tab === "ssh" && <SshAccessSection />}
      {tab === "tunnels" && isAdmin && <TunnelCleanupSection />}
    </div>
  );
}
