import { useRef, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { useAuth } from "../auth";

interface Pkg {
  id: number;
  channel: string;
  version: string;
  checksum: string;
  signature: string | null;
  notes: string | null;
  created_at: string;
}
interface Deployment {
  id: number;
  package_id: number;
  version: string;
  channel: string;
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
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);

  const [pkgId, setPkgId] = useState("");
  const [strategy, setStrategy] = useState<"all" | "group" | "canary">("all");
  const [target, setTarget] = useState("");
  const [percent, setPercent] = useState(100);

  function detectedVersion(filename: string): string | null {
    const match = /^screenboard-agent-linux-(?:amd64|arm64)-v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(filename);
    return match?.[1] ?? null;
  }

  async function uploadPkg(file: File) {
    const parsedVersion = detectedVersion(file.name);
    const packageVersion = parsedVersion ?? version.trim();
    if (!packageVersion) return alert("Use a versioned build file or set a version first");
    if (parsedVersion) setVersion(parsedVersion);
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const q = new URLSearchParams({ channel, version: packageVersion });
      if (signature) q.set("signature", signature);
      await api.uploadWithType(`/api/ota/packages?${q}`, "application/octet-stream", buf);
      setVersion("");
      setSignature("");
      reloadPkgs();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
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
    if (!confirm("Delete this OTA package and its rollouts? This cannot be undone.")) return;
    await api.del(`/api/ota/packages/${id}`);
    reloadPkgs(); reloadDeps();
  }
  async function deleteDeployment(id: number) {
    if (!confirm("Delete this rollout?")) return;
    await api.del(`/api/ota/deployments/${id}`);
    reloadDeps();
  }

  if (!isAdmin) return <div className="text-slate-500">OTA management requires the admin role.</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">OTA updates</h1>

      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">Upload agent package</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs text-slate-500">Channel</label>
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="stable">stable</option>
              <option value="beta">beta</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">Version</label>
            <input className="input" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Automatically detected from build filename" />
          </div>
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-slate-500">Signature (base64, optional)</label>
            <input className="input" value={signature} onChange={(e) => setSignature(e.target.value)} />
          </div>
        </div>
        <label className="btn-primary inline-flex cursor-pointer">
          {busy ? "Uploading…" : "Choose binary & upload"}
          <input ref={fileRef} type="file" className="hidden"
            onChange={(e) => e.target.files?.[0] && void uploadPkg(e.target.files[0])} />
        </label>
      </div>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr><th className="th">Version</th><th className="th">Channel</th><th className="th">Checksum</th><th className="th">Signed</th><th className="th">Created</th><th className="th"></th></tr>
          </thead>
          <tbody>
            {(pkgs ?? []).map((p) => (
              <tr key={p.id}>
                <td className="td font-medium">{p.version}</td>
                <td className="td">{p.channel}</td>
                <td className="td font-mono text-xs">{p.checksum.slice(0, 12)}…</td>
                <td className="td">{p.signature ? "✓" : "—"}</td>
                <td className="td text-xs text-slate-500">{p.created_at}</td>
                <td className="td text-right"><button className="text-xs text-red-600 hover:underline" onClick={() => void deletePackage(p.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">New rollout</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs text-slate-500">Package</label>
            <select className="input" value={pkgId} onChange={(e) => setPkgId(e.target.value)}>
              <option value="">— pick —</option>
              {(pkgs ?? []).map((p) => <option key={p.id} value={p.id}>{p.version} ({p.channel})</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">Strategy</label>
            <select className="input" value={strategy} onChange={(e) => setStrategy(e.target.value as "all" | "group" | "canary")}>
              <option value="all">all</option>
              <option value="group">group</option>
              <option value="canary">canary %</option>
            </select>
          </div>
          {strategy === "group" && (
            <div>
              <label className="mb-1 block text-xs text-slate-500">Group</label>
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">— pick —</option>
                {(groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          )}
          {strategy === "canary" && (
            <div>
              <label className="mb-1 block text-xs text-slate-500">Percent</label>
              <input className="input" type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
            </div>
          )}
          <div className="flex items-end">
            <button className="btn-primary" onClick={createDeployment}>Deploy</button>
          </div>
        </div>
      </div>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr><th className="th">Version</th><th className="th">Strategy</th><th className="th">Scope</th><th className="th">Status</th><th className="th"></th></tr>
          </thead>
          <tbody>
            {(deps ?? []).map((d) => (
              <tr key={d.id}>
                <td className="td font-medium">{d.version}</td>
                <td className="td">{d.strategy}</td>
                <td className="td">{d.strategy === "canary" ? `${d.percent}%` : d.target ?? "all"}</td>
                <td className="td">{d.status}</td>
                <td className="td text-right">
                  {d.status === "active" ? (
                    <button className="text-xs text-amber-600 hover:underline" onClick={() => setStatus(d.id, "paused")}>Pause</button>
                  ) : (
                    <button className="text-xs text-green-600 hover:underline" onClick={() => setStatus(d.id, "active")}>Resume</button>
                  )}
                  <button className="ml-3 text-xs text-red-600 hover:underline" onClick={() => void deleteDeployment(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
