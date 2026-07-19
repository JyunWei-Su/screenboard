import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, contentUrl } from "../api";
import { useFetch } from "../hooks";
import { useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, otaStatusLabels, otaStrategyLabels } from "../labels";

interface Pkg {
  id: number;
  channel: string;
  version: string;
  arch: string | null;
  checksum: string;
  notes: string | null;
  created_at: string;
}
interface Deployment {
  id: number;
  package_id: number;
  version: string;
  channel: string;
  arch: string | null;
  strategy: string;
  target: string | null;
  percent: number;
  status: string;
}
interface NamedRow { id: number; name: string }

export default function Ota() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: pkgs, reload: reloadPkgs } = useFetch<Pkg[]>("/api/ota/packages");
  const { data: deps, reload: reloadDeps } = useFetch<Deployment[]>("/api/ota/deployments");
  const { data: groups } = useFetch<NamedRow[]>("/api/groups");

  const fileRef = useRef<HTMLInputElement>(null);
  const [channel, setChannel] = useState("stable");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const [pkgId, setPkgId] = useState("");
  const [strategy, setStrategy] = useState<"all" | "group" | "canary">("all");
  const [target, setTarget] = useState("");
  const [percent, setPercent] = useState(100);
  const [selectedPackageIds, setSelectedPackageIds] = useState<Set<number>>(new Set());
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<Set<number>>(new Set());

  // Build filenames are screenboard-agent-linux-<arch>-v<version> (see
  // agent/build.sh); the version reads straight off the name. The architecture
  // is detected server-side from the binary's ELF header, so it doesn't depend
  // on the filename at all.
  function detectedVersion(filename: string): string | null {
    const match = /^screenboard-agent-linux-(?:amd64|arm64)-v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(filename);
    return match ? match[1] : null;
  }

  async function uploadPkg(file: File) {
    const parsed = detectedVersion(file.name);
    const packageVersion = parsed ?? version.trim();
    if (!packageVersion) return alert("請使用含版本號的建置檔,或先設定版本。");
    if (parsed) setVersion(parsed);
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const q = new URLSearchParams({ channel, version: packageVersion });
      await api.uploadWithType(`/api/ota/packages?${q}`, "application/octet-stream", buf);
      setVersion("");
      reloadPkgs();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(msg === "unrecognized_arch" ? "無法辨識架構:請上傳有效的 agent ELF 二進位檔。" : `上傳失敗:${msg}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function downloadPackage(p: Pkg) {
    setDownloadingId(p.id);
    try {
      const res = await fetch(contentUrl(`/api/content/ota/${p.id}`));
      if (!res.ok) throw new Error(`下載失敗 (${res.status})`);
      const blob = await res.blob();
      // Reconstruct the canonical build filename; the blob: URL is same-origin so
      // the download attribute's name is always honored, even cross-origin API.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `screenboard-agent-linux-${p.arch ?? "unknown"}-v${p.version}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : "下載失敗");
    } finally {
      setDownloadingId(null);
    }
  }
  async function createDeployment() {
    if (!pkgId) return;
    await api.post("/api/ota/deployments", {
      package_id: Number(pkgId),
      strategy,
      target: strategy === "group" ? target : null,
      percent: strategy === "canary" ? percent : 100,
    });
    reloadDeps();
  }
  async function setStatus(id: number, status: string) {
    await api.patch(`/api/ota/deployments/${id}`, { status });
    reloadDeps();
  }
  async function deletePackage(id: number) {
    if (!confirm("要刪除此 OTA 套件及其推送嗎?此操作無法復原。")) return;
    await api.del(`/api/ota/packages/${id}`);
    reloadPkgs();
    reloadDeps();
  }
  async function deleteDeployment(id: number) {
    if (!confirm("要刪除此推送嗎?")) return;
    await api.del(`/api/ota/deployments/${id}`);
    reloadDeps();
  }
  function toggleSelection(setter: Dispatch<SetStateAction<Set<number>>>, id: number) {
    setter((selected) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function deleteSelectedPackages() {
    const ids = [...selectedPackageIds];
    if (!ids.length || !confirm(`要刪除選取的 ${ids.length} 個 OTA 套件及其推送嗎？此操作無法復原。`)) return;
    await api.del("/api/ota/packages/batch", { ids });
    setSelectedPackageIds(new Set());
    await Promise.all([reloadPkgs(), reloadDeps()]);
  }
  async function deleteSelectedDeployments() {
    const ids = [...selectedDeploymentIds];
    if (!ids.length || !confirm(`要刪除選取的 ${ids.length} 個 OTA 推送嗎？此操作無法復原。`)) return;
    await api.del("/api/ota/deployments/batch", { ids });
    setSelectedDeploymentIds(new Set());
    await reloadDeps();
  }

  if (!isAdmin)
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500 dark:border-dark-border dark:bg-dark-surface dark:text-dark-muted">
        OTA 管理需要管理員權限。
      </div>
    );

  return (
    <div className="space-y-6">
      <PageHeader title="OTA 更新" subtitle="發布 agent 版本並管理推送" />

      <div className="card space-y-4">
        <h2 className="card-title">上傳 agent 套件</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">通道</label>
            <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="stable">stable</option>
              <option value="beta">beta</option>
            </select>
          </div>
          <div>
            <label className="label">版本</label>
            <input
              className="input"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="從檔名自動偵測"
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-dark-muted">架構會從二進位檔自動偵測(amd64 / arm64),無需手動選擇。</p>
        <label className="btn-primary inline-flex cursor-pointer">
          {busy ? "上傳中…" : "選擇二進位檔並上傳"}
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void uploadPkg(e.target.files[0])}
          />
        </label>
      </div>

      <div className="space-y-3">
        <h2 className="card-title">套件</h2>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setSelectedPackageIds(new Set((pkgs ?? []).map((pkg) => pkg.id)))}>全選</button>
          <button className="btn-danger" disabled={!selectedPackageIds.size} onClick={() => void deleteSelectedPackages()}>
            刪除選取（{selectedPackageIds.size}）
          </button>
        </div>
        <TableCard>
          <table className="w-full min-w-[680px]">
            <thead>
              <tr>
                <th className="th w-10" />
                <th className="th">版本</th>
                <th className="th">通道</th>
                <th className="th">架構</th>
                <th className="th">校驗碼</th>
                <th className="th">建立時間</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {(pkgs ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="td"><input type="checkbox" checked={selectedPackageIds.has(p.id)} onChange={() => toggleSelection(setSelectedPackageIds, p.id)} aria-label={`選取 ${p.version}`} /></td>
                  <td className="td font-medium">{p.version}</td>
                  <td className="td">{p.channel}</td>
                  <td className="td font-mono text-xs">{p.arch ?? "未知"}</td>
                  <td className="td font-mono text-xs">{p.checksum.slice(0, 12)}…</td>
                  <td className="td whitespace-nowrap text-xs text-slate-500">{p.created_at}</td>
                  <td className="td whitespace-nowrap text-right">
                    <button
                      className="text-xs font-medium text-brand-600 hover:underline disabled:opacity-50"
                      disabled={downloadingId === p.id}
                      onClick={() => void downloadPackage(p)}
                    >
                      {downloadingId === p.id ? "下載中…" : "下載"}
                    </button>
                    <button
                      className="ml-3 text-xs font-medium text-red-600 hover:underline"
                      onClick={() => void deletePackage(p.id)}
                    >
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
              {pkgs && pkgs.length === 0 && <EmptyRow colSpan={7}>尚未上傳套件。</EmptyRow>}
            </tbody>
          </table>
        </TableCard>
      </div>

      <div className="card space-y-4">
        <h2 className="card-title">新增推送</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">套件</label>
            <select className="select" value={pkgId} onChange={(e) => setPkgId(e.target.value)}>
              <option value="">— 選擇 —</option>
              {(pkgs ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.version} ({p.channel} · {p.arch ?? "未知"})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">策略</label>
            <select
              className="select"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as "all" | "group" | "canary")}
            >
              <option value="all">全部</option>
              <option value="group">裝置群組</option>
              <option value="canary">金絲雀(%)</option>
            </select>
          </div>
          {strategy === "group" && (
            <div>
              <label className="label">裝置群組</label>
              <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">— 選擇 —</option>
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {strategy === "canary" && (
            <div>
              <label className="label">百分比</label>
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
              />
            </div>
          )}
          <div className="flex items-end">
            <button className="btn-primary w-full sm:w-auto" onClick={createDeployment}>
              部署
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="card-title">推送</h2>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setSelectedDeploymentIds(new Set((deps ?? []).map((deployment) => deployment.id)))}>全選</button>
          <button className="btn-danger" disabled={!selectedDeploymentIds.size} onClick={() => void deleteSelectedDeployments()}>
            刪除選取（{selectedDeploymentIds.size}）
          </button>
        </div>
        <TableCard>
          <table className="w-full min-w-[600px]">
            <thead>
              <tr>
                <th className="th w-10" />
                <th className="th">版本</th>
                <th className="th">架構</th>
                <th className="th">策略</th>
                <th className="th">範圍</th>
                <th className="th">狀態</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {(deps ?? []).map((d) => (
                <tr key={d.id}>
                  <td className="td"><input type="checkbox" checked={selectedDeploymentIds.has(d.id)} onChange={() => toggleSelection(setSelectedDeploymentIds, d.id)} aria-label={`選取 ${d.version}`} /></td>
                  <td className="td font-medium">{d.version}</td>
                  <td className="td font-mono text-xs">{d.arch ?? "未知"}</td>
                  <td className="td">{label(otaStrategyLabels, d.strategy)}</td>
                  <td className="td">{d.strategy === "canary" ? `${d.percent}%` : d.target ?? "全部"}</td>
                  <td className="td">
                    <span
                      className={`badge ${
                        d.status === "active"
                          ? "bg-green-100 text-green-700"
                          : d.status === "paused"
                            ? "bg-amber-100 text-amber-700"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {label(otaStatusLabels, d.status)}
                    </span>
                  </td>
                  <td className="td whitespace-nowrap text-right">
                    {d.status === "active" ? (
                      <button
                        className="text-xs font-medium text-amber-600 hover:underline"
                        onClick={() => setStatus(d.id, "paused")}
                      >
                        暫停
                      </button>
                    ) : (
                      <button
                        className="text-xs font-medium text-green-600 hover:underline"
                        onClick={() => setStatus(d.id, "active")}
                      >
                        恢復
                      </button>
                    )}
                    <button
                      className="ml-3 text-xs font-medium text-red-600 hover:underline"
                      onClick={() => void deleteDeployment(d.id)}
                    >
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
              {deps && deps.length === 0 && <EmptyRow colSpan={7}>尚無推送。</EmptyRow>}
            </tbody>
          </table>
        </TableCard>
      </div>
    </div>
  );
}
