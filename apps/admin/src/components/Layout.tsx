import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { useTheme } from "../theme";
import {
  IconCalendar,
  IconClose,
  IconDashboard,
  IconDownload,
  IconImage,
  IconLayers,
  IconList,
  IconLogout,
  IconMenu,
  IconMonitor,
  IconMonitorPlay,
  IconMoon,
  IconScene,
  IconSceneStack,
  IconSun,
  IconUsers,
} from "./icons";

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const nav: NavItem[] = [
  { to: "/", label: "儀表板", end: true, Icon: IconDashboard },
  { to: "/devices", label: "裝置", Icon: IconMonitor },
  { to: "/groups", label: "群組", Icon: IconLayers },
  { to: "/playlists", label: "播放清單", Icon: IconList },
  { to: "/scenes", label: "場景", Icon: IconScene },
  { to: "/scene-playlists", label: "場景輪播", Icon: IconSceneStack },
  { to: "/media", label: "媒體", Icon: IconImage },
  { to: "/schedules", label: "排程", Icon: IconCalendar },
  { to: "/ota", label: "OTA", Icon: IconDownload },
  { to: "/users", label: "使用者", Icon: IconUsers },
];

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      className="btn-ghost btn-sm !p-2"
      onClick={toggle}
      aria-label={theme === "dark" ? "切換為淺色模式" : "切換為深色模式"}
      title={theme === "dark" ? "淺色模式" : "深色模式"}
    >
      {theme === "dark" ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
    </button>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer is open on mobile.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const initial = user?.name?.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-dark-bg">
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — fixed on desktop, slide-in drawer on mobile/tablet */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 ease-out lg:translate-x-0 dark:border-dark-border dark:bg-dark-surface ${
          open ? "translate-x-0 shadow-xl" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-white">
              <IconMonitorPlay className="h-5 w-5" />
            </span>
            <span className="text-lg font-bold tracking-tight text-brand-700 dark:text-brand-300">
              ScreenBoard
            </span>
          </div>
          <button
            className="btn-ghost btn-sm !p-1.5 lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="關閉選單"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {nav.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-dark-muted dark:hover:bg-dark-raised dark:hover:text-dark-text"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={`h-5 w-5 shrink-0 ${
                      isActive
                        ? "text-brand-600 dark:text-brand-300"
                        : "text-slate-400 group-hover:text-slate-600 dark:text-dark-subtle dark:group-hover:text-dark-muted"
                    }`}
                  />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-200 p-3 dark:border-dark-border">
          <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800 dark:text-dark-text">
                {user?.name}
              </div>
              <div className="text-xs capitalize text-slate-400 dark:text-dark-subtle">
                {user?.role}
              </div>
            </div>
            <button
              className="btn-ghost btn-sm !p-2"
              onClick={() => logout()}
              aria-label="登出"
              title="登出"
            >
              <IconLogout className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur sm:px-6 dark:border-dark-border dark:bg-dark-surface/80">
          <button
            className="btn-ghost btn-sm !p-2 lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="開啟選單"
          >
            <IconMenu className="h-5 w-5" />
          </button>
          <div className="hidden text-sm text-slate-500 sm:block dark:text-dark-muted">
            數位看板管理
          </div>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden text-slate-600 sm:inline dark:text-dark-muted">
              {user?.name} <span className="text-slate-400 dark:text-dark-subtle">({user?.role})</span>
            </span>
            <ThemeToggle />
            <button className="btn-ghost btn-sm" onClick={() => logout()}>
              <IconLogout className="h-4 w-4" />
              <span className="hidden sm:inline">登出</span>
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6 lg:p-8">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
