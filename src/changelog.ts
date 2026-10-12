/**
 * What changed for people, newest first. Each entry shows once in What's new, on the first start
 * after the update that brings it, and all of them are in Settings, About.
 *
 * Add an entry at the top for each update people would notice. The id is the day it goes out,
 * as YYYY-MM-DD; two on one day take -2, -3.
 *
 * Write for people, not developers: short, plain and friendly, like an app store's What's new.
 * Say what somebody can now do or what got better, never how it was made. Only what people would
 * notice and care about; leave out small fixes and anything technical.
 */
export interface ChangelogEntry {
  id: string
  title: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-10-12',
    title: 'Instant pictures and channel emoji',
    items: [
      'Pictures, videos and link previews now load instantly, even offline.',
      'Give any channel an emoji, like 🔫 for an airsoft channel.',
      'Right click a channel and pick Edit channel to change everything about it in one place.',
      'Create and reorder your channels in Space settings, under Channels.',
      'Read something on one device and it shows as read on all of them.',
    ],
  },
  {
    id: '2026-10-06',
    title: 'Opens instantly',
    items: [
      'Your spaces and messages show up the moment you open Nook.',
      'Deleting a message is quicker to confirm.',
    ],
  },
  {
    id: '2026-10-05',
    title: 'Faster everywhere',
    items: [
      'Spaces open faster and typing feels snappier.',
      'Long chats scroll more smoothly.',
      'See what’s new after each update. Find it again in Settings, About.',
    ],
  },
  {
    id: '2026-10-04',
    title: 'Clearer voice',
    items: [
      'Fixed crackly voice after Nook had been in the background for a while.',
      'Save pictures and videos to your device.',
      'Nook uses less memory.',
    ],
  },
  {
    id: '2026-10-03',
    title: 'Spoilers and NSFW channels',
    items: [
      'Hide text in a ||spoiler||. Others tap it to reveal it.',
      'Mark a channel as NSFW to blur its pictures, or Media only for just pictures and videos.',
      'Start a space from a Discord template link.',
      'Make a voice channel listen only, so only hosts can talk.',
    ],
  },
  {
    id: '2026-10-02',
    title: 'Nook for Android',
    items: [
      'Nook is on Android, with notifications and calls that keep going in the background.',
      'Ten new voices in the voice changer.',
      'New here? A quick tour shows you around.',
    ],
  },
  {
    id: '2026-10-01',
    title: 'Voice messages',
    items: [
      'Send voice messages.',
      'Add a cover picture to your profile.',
      'Change how you sound with the voice changer.',
      'Favourite GIFs to find them again.',
      'The desktop app can keep running in the tray.',
    ],
  },
]
