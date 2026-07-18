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

type TabKey = "users" | "ssh";

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
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setEmails(data.emails.join("\n"));
  }, [data]);

  async function save() {
    const values = emails.split(/[\n,]/).map((email) => email.trim()).filter(Boolean);
    setBusy(true);
    try {
      const result = await api.put<{ emails: string[] }>("/api/settings/ssh-access", { emails: values });
      setEmails(result.emails.join("\n"));
      showToast("已儲存。裝置下次按「修復 SSH」時會自動套用。", "success");
      reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "儲存失敗", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card max-w-2xl space-y-4">
      <div>
        <h2 className="card-title">SSH Access 允許信箱</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-dark-muted">
          每行一個信箱。儲存後不需要重新部署；請於裝置頁按「佈建／重新佈建 SSH」套用至既有 Tunnel。
        </p>
      </div>
      {!data?.configured && <p className="text-sm text-amber-600">Cloudflare SSH 遠端存取尚未完成設定。</p>}
      <textarea
        className="input min-h-36 font-sans"
        value={emails}
        disabled={!writable || busy}
        placeholder="ops@example.com\nadmin@example.com"
        onChange={(event) => setEmails(event.target.value)}
      />
      {writable ? (
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "儲存中…" : "儲存設定"}
        </button>
      ) : (
        <p className="text-sm text-slate-400">僅管理員可修改此設定。</p>
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
      </div>

      {tab === "users" && isAdmin && <UsersSettings />}
      {tab === "ssh" && <SshAccessSection />}
    </div>
  );
}
