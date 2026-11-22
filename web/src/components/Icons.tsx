// 線画のアイコン (色は文字色に合わせる)
import type { ReactNode } from 'react';

type P = { size?: number };

const svg = (size: number, children: ReactNode, strokeWidth = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconHome = ({ size = 20 }: P) => svg(size, <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />);
export const IconList = ({ size = 20 }: P) => svg(size, <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />);
export const IconInbox = ({ size = 20 }: P) =>
  svg(size, <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" /></>);
export const IconSwap = ({ size = 20 }: P) =>
  svg(size, <><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>);
export const IconChart = ({ size = 20 }: P) => svg(size, <path d="M12 20V10M18 20V4M6 20v-4" />);
export const IconGear = ({ size = 20 }: P) =>
  svg(size, <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>);
export const IconPlus = ({ size = 20 }: P) => svg(size, <path d="M12 5v14M5 12h14" />, 2.5);
export const IconAlert = ({ size = 20 }: P) => svg(size, <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>);
export const IconLogout = ({ size = 20 }: P) =>
  svg(size, <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></>);
export const IconCopy = ({ size = 20 }: P) =>
  svg(size, <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const IconScale = ({ size = 20 }: P) =>
  svg(size, <><path d="M12 3v18M5 21h14M7 7l-4 8a4 4 0 0 0 8 0zM17 7l-4 8a4 4 0 0 0 8 0zM5 7h14" /></>);
export const IconApps = ({ size = 20 }: P) =>
  svg(size, <><path d="M15 3h6v6M10 14L21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>);
