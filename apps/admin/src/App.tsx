import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Devices from "./pages/Devices";
import DeviceDetail from "./pages/DeviceDetail";
import Groups from "./pages/Groups";
import Playlists from "./pages/Playlists";
import PlaylistEditor from "./pages/PlaylistEditor";
import Media from "./pages/Media";
import Schedules from "./pages/Schedules";
import Ota from "./pages/Ota";
import Users from "./pages/Users";

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
        <Route path="/playlists" element={<Playlists />} />
        <Route path="/playlists/:id" element={<PlaylistEditor />} />
        <Route path="/media" element={<Media />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/ota" element={<Ota />} />
        <Route path="/users" element={<Users />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
