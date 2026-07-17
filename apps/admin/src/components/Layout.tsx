import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth";

const nav = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/devices", label: "Devices" },
  { to: "/groups", label: "Groups" },
  { to: "/playlists", label: "Playlists" },
  { to: "/media", label: "Media" },
  { to: "/schedules", label: "Schedules" },
  { to: "/ota", label: "OTA" },
  { to: "/events", label: "Events" },
  { to: "/users", label: "Users" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="w-56 shrink-0 border-r border-slate-200 bg-white">
        <div className="px-4 py-5 text-lg font-bold text-brand-600">ScreenBoard</div>
        <nav className="flex flex-col gap-0.5 px-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div className="text-sm text-slate-500">Digital Signage Management</div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {user?.name} <span className="text-slate-400">({user?.role})</span>
            </span>
            <button className="btn-ghost" onClick={() => logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
