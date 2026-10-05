/**
 * What changed for people, newest first. Each entry shows once in What's new, on the first start
 * after the update that brings it, and all of them are in Settings, About.
 *
 * Add an entry at the top for each update people would notice. The id is the day it goes out,
 * as YYYY-MM-DD; two on one day take -2, -3. Write what somebody can now do, in a few words,
 * not how it was made.
 */
export interface ChangelogEntry {
  id: string
  title: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-10-05',
    title: 'Faster everywhere',
    items: [
      'Spaces open about a quarter sooner, and typing takes a third of the work it did.',
      'Long channels scroll more smoothly, with half as much on the page.',
      'The side bars no longer flash under the pointer when something changes.',
      'What’s new: this window, after each update. Find it again in Settings, About.',
    ],
  },
  {
    id: '2026-10-04',
    title: 'Clearer voice, and Save',
    items: [
      'Voice no longer crackles after Nook has been put away for a while.',
      'Pictures and videos have Save.',
      'Each person can play twenty soundboard sounds an hour.',
      'Nook takes less memory: emoji are lighter, and GIFs play only while you can see them.',
    ],
  },
  {
    id: '2026-10-03',
    title: 'Spoilers, NSFW channels and Discord templates',
    items: [
      'Hide words in a ||spoiler||. People scratch it to read it.',
      'Mark a channel NSFW, and its pictures stay blurred until clicked. Or make it Media only.',
      'Paste a Discord template link to make a space with its channels and roles.',
      'A voice channel can be No talking: only its owner and the people who keep channels are heard.',
      'A markdown file in a message shows its top, and opens in a reader.',
      'Change your voice right from the voice channel.',
    ],
  },
  {
    id: '2026-10-02',
    title: 'Ten new voices, and an Android app',
    items: [
      'Ten more voices in the voice changer, with a live preview of each.',
      'An Android app, with notifications and calls that keep going in the background.',
      'Somebody new gets a short tour of Nook.',
      'Add a sound straight from the soundboard.',
    ],
  },
  {
    id: '2026-10-01',
    title: 'Voice messages, and a cover for your profile',
    items: [
      'Record a voice message right in the message box.',
      'Your profile has a cover picture.',
      'A voice changer, and a phone can play the soundboard into your call on another device.',
      'Star a GIF to keep it in Favourites.',
      'The desktop app can close to the tray, and counts what you missed.',
    ],
  },
]
