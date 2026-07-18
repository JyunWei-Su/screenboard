import { useEffect, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { PageHeader } from "../components/ui";
import { useToast } from "../toast";

interface SshAccessSettings {
  emails: string[];
  configured: boolean;
}

export default function Settings() {
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
    <div className="space-y-5">
      <PageHeader title="系統設定" subtitle="管理 Cloudflare Access 與 SSH 的執行期設定。" />
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
    </div>
  );
}
