# Nook redesign brief (for Claude Code)

You're restyling the Nook chat app to the Nook design system in this folder. Read `STYLE_GUIDE.md` first; it's the source of truth for colour roles, type, motion and component rules. This file is the implementation plan.

## What's in this bundle

```
nook-brand/
  STYLE_GUIDE.md            brand + UI rules (read first)
  tokens/
    tokens.json             source tokens (light + dark)
    tokens.css              CSS variables, [data-theme] + prefers-color-scheme, type classes (.text-*)
    tailwind-theme.css      Tailwind v4 @theme mapping (bg-surface-0, text-text-secondary, rounded-lg, shadow-1 ...)
  styles/
    motion.css              ghost animations (idle, typing, sleeping, peek, wiggle, vanish) + reduced-motion
    components.css          .nook-btn, .nook-message, .nook-mention, .nook-composer, .nook-typing, .nook-avatar, .nook-badge
  react/
    NookGhost.tsx           <NookGhost mood entrance size/> and <TypingIndicator names/>
    NookLogo.tsx            token-coloured lockup
    icons.tsx               27 icons as React components (currentColor)
  icons/*.svg               same icons as files (currentColor)
  logo/*.svg                fixed-colour logos, app icons, typing/sleeping stills
  logo/png/*.png            app icons 1024/512/180/32/16, maskable 512/192, rounded 512/192, lockups 1200w
  logo/favicon.ico
```

## Steps

1. **Fonts.** In the root layout load with `next/font/google`: `Bricolage_Grotesque` (weights 700, 800), `DM_Sans` (400, 500, 600), `JetBrains_Mono` (400, 500). Expose them as CSS variables and set `--font-display`, `--font-sans`, `--font-mono` on `<html>` so they override the fallback stacks in tokens.css.
2. **Tokens.** Copy `tokens/tokens.css`, `styles/motion.css`, `styles/components.css` into the app's styles and import them from the global stylesheet (tokens first). If the app uses Tailwind v4, also import `tokens/tailwind-theme.css` after `tailwindcss`. Utilities then read like `bg-surface-1 text-text-secondary rounded-lg shadow-1 font-display`. If it's on Tailwind v3, translate the same mapping into `theme.extend` with `var(--token)` values.
3. **Theme switching.** Default to the OS (no attribute). Add a System / Light / Dark control in settings that sets `data-theme` on `<html>` and persists the choice (cookie so SSR renders the right theme with no flash). Remove any existing `dark:` colour variants; tokens already swap.
4. **Replace raw colours.** Grep for hex values, `bg-white`, `text-gray-*`, `bg-black` etc. and map them to semantic tokens using the roles in STYLE_GUIDE.md > Colour. No hex should remain in components.
5. **Logo + icons.** Swap the header logo for `<NookLogo />` (or `<NookGhost />` where it's square). Replace the current icon library with `react/icons.tsx`. Use the `GhostIcon` for the chats tab and new-chat action.
6. **Chat screen.** Lay it out like Discord, not like a phone messenger: no bubbles, and every message on the left.
   - Group messages by sender (new group on sender change or 5-min gap). The first message of a group is `.nook-message--first` with `.nook-message__avatar` (40px) and a `.nook-message__head` (name, then time). The rest of the group are plain `.nook-message` rows with the time in `.nook-message__gutter-time`, shown on hover.
   - A message that names you gets `.nook-message--mention`. Names in a message are `.nook-mention` chips (`.nook-mention--me` for you).
   - Receipts, if the app has them: `CheckIcon` sent, `CheckDoubleIcon` delivered, `GhostIcon` read, after the time in `text-muted`.
   - Replace any "is typing..." text/dots with `<TypingIndicator names={[...]} />` above the composer.
   - Deleting or expiring a message: add `nook-vanish` to the row and remove it on `animationend`.
   - Composer: `.nook-composer` pill; mic when empty, ember `.nook-send` button when there's text.
   - Pinned messages: a short card with the words (3 lines at most) and a line for any files. Never play media in it; a click goes to the message.
7. **Inbox.** Rows per STYLE_GUIDE (avatar 44px on `accent-soft`, presence dot, unread badge, receipts before your own last message). Empty inbox: centred `<NookGhost mood="idle" size={96} />` + short line in `text-title` + primary button.
8. **States.** Offline / reconnecting banner uses `<NookGhost mood="sleeping" size={24} />` + text on `surface-2`. Mentions trigger `entrance="wiggle"` on the ghost in the tab bar.
9. **App icons + meta.** Replace favicon and app icons from `logo/png` + `logo/favicon.ico`. PWA manifest: `app-icon-maskable-512.png` with `"purpose": "maskable"`, rounded 512/192 as `"any"`; `theme_color` #151518, `background_color` #FBF7EF. `apple-touch-icon` = `app-icon-180.png`.
10. **Check.** Both themes on every screen, keyboard focus visible everywhere (2px focus-ring, 2px offset), 44px hit areas, `prefers-reduced-motion` stops the loops, only one animated ghost on screen at a time.

## Don'ts

- No new colours, gradients, glass/blur backgrounds or extra shadows beyond `shadow-1` / `shadow-2`.
- Don't put text on ember except `on-accent` (ink). Never white on ember.
- Don't draw chat bubbles; messages are rows on the page, all on the left.
- Don't animate messages or buttons with bounce; only the ghost overshoots.
- Don't retype the wordmark or recolour the ghost.
