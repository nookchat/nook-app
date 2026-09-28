"use client";
import type { SVGProps } from "react";

// The Nook bubble ghost. Colours come from tokens (--brand, --on-brand, --accent) via styles/motion.css,
// so it flips correctly in light and dark. Motion classes live in styles/motion.css.
export type GhostMood = "idle" | "typing" | "sleeping" | "still";
export type GhostEntrance = "peek" | "wiggle" | undefined;

const BODY = "M24 60 A36 36 0 0 1 96 60 L96 96 Q90 104 84 97 Q78 90 72 97 Q66 104 60 97 Q54 90 48 97 Q42 104 36 97 L17 110 Q24 100 24 86 Z";

export function NookGhost({
  mood = "still", entrance, size = 48, label, className = "", ...rest
}: { mood?: GhostMood; entrance?: GhostEntrance; size?: number; label?: string } & SVGProps<SVGSVGElement>) {
  const classes = ["nook-ghost", mood !== "still" && `nook-ghost--${mood}`, entrance && `nook-ghost--${entrance}`, className]
    .filter(Boolean).join(" ");
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={classes}
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} {...rest}>
      <g transform="translate(3.5 -7)">
        <path className="nook-ghost__body" d={BODY} />
        {mood === "typing" ? (
          <>
            <circle className="nook-ghost__dot" cx="46" cy="64" r="5.5" />
            <circle className="nook-ghost__dot" cx="60" cy="64" r="5.5" />
            <circle className="nook-ghost__dot" cx="74" cy="64" r="5.5" />
          </>
        ) : mood === "sleeping" ? (
          <path className="nook-ghost__lids" d="M43 63 Q49 68 55 63 M65 63 Q71 68 77 63" fill="none" strokeWidth={3.5} strokeLinecap="round" />
        ) : (
          <g className="nook-ghost__eyes">
            <ellipse cx="49" cy="62" rx="5" ry="7" />
            <ellipse cx="71" cy="62" rx="5" ry="7" />
          </g>
        )}
        {size >= 20 && (
          <g className="nook-ghost__cheeks">
            <circle cx="40" cy="75" r="4.5" />
            <circle cx="80" cy="75" r="4.5" />
          </g>
        )}
      </g>
    </svg>
  );
}

export function TypingIndicator({ names }: { names: string[] }) {
  if (!names.length) return null;
  const text = names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : "Several people are typing";
  return (
    <div className="nook-typing" role="status" aria-live="polite">
      <NookGhost mood="typing" entrance="peek" size={32} />
      <span>{text}</span>
    </div>
  );
}
