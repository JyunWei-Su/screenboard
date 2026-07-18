import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Devices from "./pages/Devices";
import DeviceDetail from "./pages/DeviceDetail";
import Groups from "./pages/Groups";
import Scenes from "./pages/Scenes";
import SceneEditor from "./pages/SceneEditor";
import ScenePlaylists from "./pages/ScenePlaylists";
import ScenePlaylistEditor from "./pages/ScenePlaylistEditor";
import Media from "./pages/Media";
import Schedules from "./pages/Schedules";
import Ota from "./pages/Ota";
import Settings from "./pages/Settings";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-500">Loading…</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={user ? <Layout /> : <Navigate to="/login" replace />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/devices/:uuid" element={<DeviceDetail />} />
        <Route path="/groups" element={<Groups />} />
        <Route path="/scenes" element={<Scenes />} />
        <Route path="/scenes/:id" element={<SceneEditor />} />
        <Route path="/scene-playlists" element={<ScenePlaylists />} />
        <Route path="/scene-playlists/:id" element={<ScenePlaylistEditor />} />
        <Route path="/scene-groups" element={<ScenePlaylists />} />
        <Route path="/scene-groups/:id" element={<ScenePlaylistEditor />} />
        <Route path="/media" element={<Media />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/ota" element={<Ota />} />
        {/* 使用者管理已併入系統設定；保留舊路徑導向。 */}
        <Route path="/users" element={<Navigate to="/settings" replace />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
