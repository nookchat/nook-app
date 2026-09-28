# Nook

A cozy corner to talk. Nook is a messenger with a small, friendly ghost at its heart: warm cream and deep night surfaces, one ember hot spot per screen, and a mascot that floats, blinks and types along with you.

This system covers light and dark themes, the bubble-ghost logo, the icon set, the ghost's motion vocabulary, and the core chat components (bubbles, composer, typing indicator, list rows, buttons).

## Voice

- **Warm, brief, lowercase-friendly.** Nook talks like a friend in the next room, not a bank. "Say hi to Maya" beats "Start a new conversation".
- **The ghost does the emoting, the copy stays plain.** Don't pun on ghosts in UI strings ("boo!", "spooky") except in one-off empty states. Never in errors.
- **Errors say what happened and what to do:** "Couldn't send. Tap to retry." Not "Oops! Something went wrong."
- The product name is written **Nook** in sentences and **nook** only inside the logo.

## Logo

The mark is the **bubble ghost**: a ghost whose scalloped hem ends in a speech-bubble tail, two eyes and ember cheeks. It says "ghost" and "message" in one shape.

| Asset | Use |
| --- | --- |
| `nook-lockup` / `-reversed` | Default brand signature: marketing, splash, auth screens. Reversed on ink or dark surfaces. |
| `nook-mark` / `-reversed` | Where space is square or tight: app header, avatars for Nook system messages, social avatars. |
| `nook-mark-mono-*` | One-colour contexts (print, embossing, notification tray). Cheeks drop out. |
| `nook-wordmark` | Only when the mark is already on screen nearby. |
| `nook-app-icon` (rounded), `-square` (iOS, the OS masks it), `-maskable` (Android/PWA safe zone), `-light` | App stores, home screen, PWA manifest, favicon. |
| `nook-ghost-typing`, `nook-ghost-sleeping` | Static stills of the mascot states for docs and marketing. In product, use the animated component. |

**Rules**

- Clear space around the mark = the width of the mark's eye-to-eye gap (about 1/5 of mark height) on every side.
- Minimum size: mark 16px (drop cheeks below 20px, the component does this automatically); lockup 72px wide.
- The ghost is always **brand** on its ground with **on-brand** eyes: ink ghost on cream, cream ghost on ink/dark. Never place the ghost on accent (ember) at small sizes; eyes lose contrast.
- Don't rotate, outline, add a gradient, redraw the tail on the right, or give the ghost limbs or accessories in the logo. Illustrations can play; the logo doesn't.
- The wordmark is Bricolage Grotesque ExtraBold, tracked -4%, supplied as outlines. Never retype it.

## Colour

Two themes, same token names. Everything is semantic: build with `surface-*`, `text-*`, `brand`, `accent`, never raw hex.

- **Light** is cream (`surface-0` #FBF7EF) with ink (#1E1B2E) type and ghost.
- **Dark** is deep night (`surface-0` #15131F) with a cream ghost. `brand` and `on-brand` **swap** between themes, so a ghost drawn with `brand`/`on-brand` is always the highest-contrast shape on screen.
- **Ember** (`accent` #FF8A5B) is the one hot spot: the ghost's cheeks, the send button, unread badges. One accent element per region. Ember is a fill: text on it is always `on-accent` (ink, 7:1). When ember must be text or a link, use `accent-text`.
- **Bubbles:** yours are `bubble-out` (ink in light, ember in dark), theirs are `bubble-in` (white in light, `surface-2` violet-grey in dark).
- **Status:** `online`, `danger`, `warning` are always paired with an icon or label. The presence dot also has a surface-coloured ring so it reads as a shape.
- **Contrast:** every text token is 4.5:1+ on `surface-0`, `surface-1` and `surface-2` in both themes; `border-strong`, `focus-ring` and icons are 3:1+. `border` is decorative only.

Theme switching: set `data-theme="light"` or `"dark"` on `<html>`; with no attribute the OS preference wins. Offer System / Light / Dark in settings (sun and moon icons).

## Type

- **Bricolage Grotesque** (display, 700–800): screen titles, empty-state headlines, onboarding. Tight tracking, never below 20px.
- **DM Sans** (text, 400–600): everything else. Messages are 15/22 (`text-message`), list previews 14/20, timestamps 12/16.
- **JetBrains Mono** for code inside messages only.
- Sentence case everywhere. No all-caps labels.

All three are Google Fonts. In Next.js load them with `next/font/google` and map to `--font-display`, `--font-sans`, `--font-mono`.

## Space, shape, depth

- 4px grid: `space-1` 4 through `space-8` 64. Mobile gutter `space-4`, desktop `space-6`. Bubbles from the same sender stack 3px apart; a new sender or a 5-minute gap starts a new group (`space-4` above).
- Shapes are soft and round, echoing the ghost: bubbles `radius-lg` 20 with the corner nearest the sender cut to `radius-xs` 6 **on the last bubble of a group only** (that's the tail). Buttons, composer, avatars and badges are pills. Sheets and dialogs `radius-xl` 28.
- Depth is quiet: `shadow-1` for incoming bubbles and the composer, `shadow-2` for sheets and menus. No other shadows, no glassmorphism, no gradients.

## Iconography

27 icons on a 24px grid, 1.75px stroke, round caps and joins, `currentColor`. Sized 22–24px in 44px hit areas; 15–16px inside bubbles (ticks). The set includes a **ghost** glyph (the chats tab / new chat) drawn from the logo geometry. Receipts change **shape**, not colour: `check` = sent, `check-double` = delivered, `ghost` = read (the ghost "saw" it). All in the bubble's own text colour. `vanish` (a wisp) marks disappearing messages.

Don't mix in filled or duotone icons from other sets; if something is missing, draw it on the same grid and stroke.

## Motion: the ghost

The ghost is Nook's only character and carries almost all of the app's personality. UI chrome stays calm (140–220ms fades and scales); the ghost moves.

| State / move | Class | Where | Spec |
| --- | --- | --- | --- |
| **Idle** | `nook-ghost--idle` | Empty states, splash, onboarding | Floats 5% up and down, 2.8s ease-in-out loop; blinks every 5.2s (eyes scaleY to 0.12 for ~150ms). |
| **Typing** | `nook-ghost--typing` | Replaces "is typing…" under the last message | Face becomes three dots that hop in sequence (1.2s loop, 150ms stagger); cheeks glow; body bobs on a 1.6s loop. Enters with **peek**. |
| **Sleeping** | `nook-ghost--sleeping` | Offline, no connection, quiet hours / DND | Closed crescent eyes, slow squash-and-stretch breathe (3.6s). |
| **Peek** | `nook-ghost--peek` | Typing indicator appearing, new chat created, in-app notification toast | Rises 45% from below with a small overshoot, 420ms `ease-pop`. One-shot. |
| **Wiggle** | `nook-ghost--wiggle` | You're mentioned, a pinned reply arrives, tapping the logo | Rotates about its hem, -9° / 7° / -4°, 520ms. One-shot; re-add the class to replay. |
| **Vanish** | `nook-vanish` (on the bubble) | Deleting a message, disappearing messages expiring | Drifts up 24px, shrinks to 94%, blurs 6px and fades, 600ms ease-in. Then remove from layout. |

**Rules**

- At most one ghost animating on screen at a time. The typing ghost wins over everything else.
- Everything respects `prefers-reduced-motion`: loops stop, the typing dots hold at 80% opacity, vanish becomes a 200ms fade.
- Never animate bubbles, list rows or buttons with bounce. Only the ghost overshoots.
- Sending a message: the bubble fades and rises 8px in 220ms `ease-out`. No flying paper planes.

## Components

- **Message bubbles:** grouped by sender, tail on the last bubble, meta row (time + ticks) inside the bubble at 11px, 72% opacity of the bubble's text colour.
- **Typing indicator:** 32px typing ghost + "Maya is typing" in `text-secondary`, left-aligned where the next incoming bubble will appear. `role="status"`, `aria-live="polite"`.
- **Composer:** pill on `surface-1` with `shadow-1`; attach and emoji as quiet icon buttons; send is an ember circle with an ink icon, shown only when there's text (mic otherwise).
- **Chat list row:** 44px avatar (initial on `accent-soft`, presence dot), name in `text-heading`, preview in `text-body-sm` / `text-secondary`, time in `text-caption`, unread count as an ember badge.
- **Buttons:** 44px tall pills. Primary = `brand`, accent = ember (one per screen, usually the main CTA on onboarding), secondary = `border-strong` outline, quiet = text only, danger = `danger` outline. Focus: 2px `focus-ring`, 2px offset.

## Accessibility

Hit areas are 44px minimum. Every icon-only button has an `aria-label`. Colour is never the only signal (presence has a ring, read state has double ticks, errors have text). Text meets 4.5:1 in both themes; don't put `text-muted` on `accent-soft` or bubbles.
