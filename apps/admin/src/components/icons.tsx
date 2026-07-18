import type { ReactNode, SVGProps } from "react";

// Lightweight inline icon set (Lucide-style paths) — no runtime dependency.
function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const IconDashboard = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </Svg>
);

export const IconMonitor = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
  </Svg>
);

export const IconLayers = (p: P) => (
  <Svg {...p}>
    <path d="m12 2 10 5-10 5L2 7z" />
    <path d="m2 17 10 5 10-5" />
    <path d="m2 12 10 5 10-5" />
  </Svg>
);

export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h11" />
    <path d="M3 12h11" />
    <path d="M3 18h11" />
    <path d="m17 8 4 3-4 3z" />
  </Svg>
);

export const IconImage = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-4.5-4.5L5 21" />
  </Svg>
);

export const IconCalendar = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4" />
    <path d="M8 2v4" />
    <path d="M3 10h18" />
  </Svg>
);

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m8 11 4 4 4-4" />
    <path d="M20 16.5A4.5 4.5 0 0 0 17.5 8h-1.3A7 7 0 1 0 4 14.9" />
  </Svg>
);

export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </Svg>
);

export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Svg>
);

export const IconAlertTriangle = (p: P) => (
  <Svg {...p}>
    <path d="m12 3 10 18H2L12 3z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
);

export const IconAlertOctagon = (p: P) => (
  <Svg {...p}>
    <path d="M7 2h10l5 5v10l-5 5H7l-5-5V7l5-5z" />
    <path d="M12 8v5" />
    <path d="M12 17h.01" />
  </Svg>
);

export const IconUsers = (p: P) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconMenu = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
);

export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Svg>
);

export const IconMonitorPlay = (p: P) => (
  <Svg {...p}>
    <path d="M2 3h20v14H2z" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
    <path d="m10 8 4 2-4 2z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.9 4.9 1.4 1.4" />
    <path d="m17.7 17.7 1.4 1.4" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.3 17.7-1.4 1.4" />
    <path d="m19.1 4.9-1.4 1.4" />
  </Svg>
);

export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
  </Svg>
);

// A framed canvas with positioned blocks — represents a Scene.
export const IconScene = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <rect x="6" y="7" width="6" height="5" rx="1" />
    <path d="M15 7h3" />
    <path d="M15 11h3" />
    <path d="M6 16h12" />
  </Svg>
);

// Stacked scene frames — represents a Scene playlist (rotation).
export const IconSceneStack = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="3" width="14" height="11" rx="2" />
    <path d="M3 8v11a2 2 0 0 0 2 2h11" />
    <path d="m11 6 4 2.5L11 11z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconRepeat = (p: P) => (
  <Svg {...p}>
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11V9a3 3 0 0 1 3-3h15" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v2a3 3 0 0 1-3 3H3" />
  </Svg>
);

export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18" />
    <path d="M12 3a14 14 0 0 0 0 18" />
  </Svg>
);

export const IconType = (p: P) => (
  <Svg {...p}>
    <path d="M4 6V4h16v2" />
    <path d="M12 4v16" />
    <path d="M8 20h8" />
  </Svg>
);

export const IconCompass = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" />
  </Svg>
);

export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const IconVideo = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="m16 10 5-3v10l-5-3z" />
  </Svg>
);

export const IconFileText = (p: P) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8M8 17h6" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 15H6L5 6" />
    <path d="M10 11v5M14 11v5" />
  </Svg>
);

export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </Svg>
);

export const IconUnlock = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 7.4-2" />
  </Svg>
);

export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
);

export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="m3 3 18 18" />
    <path d="M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-3.1 3.7" />
    <path d="M6.2 6.2A18.3 18.3 0 0 0 2 12s3.5 6 10 6a10 10 0 0 0 3.1-.5" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}><path d="m5 12 4 4L19 6" /></Svg>
);

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5v-3h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3.6h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);
