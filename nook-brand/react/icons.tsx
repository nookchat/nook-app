import type { SVGProps } from "react";

// Nook icon set. 24px grid, 1.75 stroke, round caps. Colour follows `currentColor`.
type IconProps = SVGProps<SVGSVGElement> & { size?: number; title?: string };

function base(children: React.ReactNode, { size = 24, title, ...rest }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : true} role={title ? "img" : undefined} {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const GhostIcon = (p: IconProps) => base(<><path d="M4.8 10.6A7.2 7.2 0 0 1 19.2 10.6L19.2 17.8Q18 19.4 16.8 18Q15.6 16.6 14.4 18Q13.2 19.4 12 18Q10.8 16.6 9.6 18Q8.4 19.4 7.2 18L3.4 20.6Q4.8 18.6 4.8 15.8Z" /><ellipse cx="9.8" cy="11" rx=".9" ry="1.3" fill="currentColor" stroke="none" /><ellipse cx="14.2" cy="11" rx=".9" ry="1.3" fill="currentColor" stroke="none" /></>, p);

export const SendIcon = (p: IconProps) => base(<><path d="M21 3 10.5 13.5" /><path d="M21 3l-6.5 18-4-7.5L3 9.5z" /></>, p);

export const AttachIcon = (p: IconProps) => base(<><path d="m20 11.5-8.4 8.4a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></>, p);

export const EmojiIcon = (p: IconProps) => base(<><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><circle cx="9" cy="10" r=".9" fill="currentColor" stroke="none" /><circle cx="15" cy="10" r=".9" fill="currentColor" stroke="none" /></>, p);

export const MicIcon = (p: IconProps) => base(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>, p);

export const CameraIcon = (p: IconProps) => base(<><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="3.5" /></>, p);

export const ImageIcon = (p: IconProps) => base(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 9" /></>, p);

export const VideoIcon = (p: IconProps) => base(<><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3z" /></>, p);

export const PhoneIcon = (p: IconProps) => base(<><path d="M5 4h3.5l1.5 4.5-2.2 1.3a11 11 0 0 0 6.4 6.4l1.3-2.2L20 15.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" /></>, p);

export const SearchIcon = (p: IconProps) => base(<><circle cx="11" cy="11" r="7" /><path d="m16.2 16.2 4.8 4.8" /></>, p);

export const PlusIcon = (p: IconProps) => base(<><path d="M12 5v14M5 12h14" /></>, p);

export const CloseIcon = (p: IconProps) => base(<><path d="M6 6l12 12M18 6 6 18" /></>, p);

export const BackIcon = (p: IconProps) => base(<><path d="m15 5-7 7 7 7" /></>, p);

export const MoreIcon = (p: IconProps) => base(<><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /></>, p);

export const CheckIcon = (p: IconProps) => base(<><path d="m5 12.5 4.5 4.5L19 7.5" /></>, p);

export const CheckDoubleIcon = (p: IconProps) => base(<><path d="m2.5 12.5 4.5 4.5 9.5-9.5M11.5 16l1 1L22 7.5" /></>, p);

export const BellIcon = (p: IconProps) => base(<><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>, p);

export const LockIcon = (p: IconProps) => base(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>, p);

export const UserIcon = (p: IconProps) => base(<><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></>, p);

export const UsersIcon = (p: IconProps) => base(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 13.8a6.5 6.5 0 0 1 3.5 6.2" /></>, p);

export const SettingsIcon = (p: IconProps) => base(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>, p);

export const TrashIcon = (p: IconProps) => base(<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>, p);

export const ReplyIcon = (p: IconProps) => base(<><path d="M9 7 4 12l5 5" /><path d="M4 12h10a6 6 0 0 1 6 6v1" /></>, p);

export const PinIcon = (p: IconProps) => base(<><path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" /></>, p);

export const MoonIcon = (p: IconProps) => base(<><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></>, p);

export const SunIcon = (p: IconProps) => base(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>, p);

export const VanishIcon = (p: IconProps) => base(<><path d="M12 21a7 7 0 0 1-7-7c0-3 2-5.5 4-8 .5 2 1.8 3 3 3 0-2 1-4 3-6 1.5 3 4 5.5 4 11a7 7 0 0 1-7 7z" /></>, p);
