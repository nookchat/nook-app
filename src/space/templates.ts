import { DEFAULT_CHANNEL, DEFAULT_VOICE } from '../store/log'
import type { RoomChat } from '../store/room-chat'

/**
 * A starting point for a new space: its channels, in order, with a topic each, and the notes it
 * opens with. Nook's own general and lounge are always there, so a template only tells them what
 * they are for. Everybody sees every channel; the owner changes any of it later.
 */

export interface TemplateChannel {
  name: string
  topic?: string
  /** A text channel for pictures, videos and files. */
  mediaOnly?: boolean
  /** A voice channel to listen in, where only the owner and whoever keeps channels are heard. */
  noTalking?: boolean
}

export interface SpaceTemplate {
  id: string
  title: string
  about: string
  /** A name to give as an example. */
  example: string
  text: TemplateChannel[]
  voice: TemplateChannel[]
  notes: { title: string; text: string }[]
}

export const SCRATCH: SpaceTemplate = {
  id: 'scratch',
  title: 'Start from scratch',
  about: 'One text channel and one voice channel. Add the rest as you go.',
  example: 'My space',
  text: [{ name: DEFAULT_CHANNEL }],
  voice: [{ name: DEFAULT_VOICE }],
  notes: [],
}

export const TEMPLATES: SpaceTemplate[] = [
  SCRATCH,
  {
    id: 'friends',
    title: 'Friends',
    about: 'Hang out, share memes and photos, and make plans.',
    example: 'The group chat',
    text: [
      { name: DEFAULT_CHANNEL, topic: 'Say hi. Talk about anything.' },
      { name: 'memes', topic: 'The funny stuff.' },
      { name: 'photos', topic: 'Pictures and videos from your days out.', mediaOnly: true },
      { name: 'plans', topic: 'Where, when and who is in.' },
    ],
    voice: [{ name: DEFAULT_VOICE }, { name: 'late-night' }],
    notes: [],
  },
  {
    id: 'gaming',
    title: 'Gaming group',
    about: 'Find a team, share clips, and jump into voice together.',
    example: 'Squad goals',
    text: [
      { name: DEFAULT_CHANNEL, topic: 'Talk about anything.' },
      { name: 'looking-for-group', topic: 'Say what you want to play, and when.' },
      { name: 'clips', topic: 'Your best plays and your worst ones.', mediaOnly: true },
      { name: 'patch-notes', topic: 'Updates, news and leaks.' },
    ],
    voice: [{ name: DEFAULT_VOICE }, { name: 'squad-1' }, { name: 'squad-2' }, { name: 'afk' }],
    notes: [],
  },
  {
    id: 'study',
    title: 'Study group',
    about: 'Help with homework, a place for notes, and a quiet room.',
    example: 'Study hall',
    text: [
      { name: DEFAULT_CHANNEL, topic: 'Talk about anything.' },
      { name: 'homework-help', topic: 'Ask a question. Show what you tried.' },
      { name: 'resources', topic: 'Links, slides and past papers.' },
      { name: 'off-topic', topic: 'Take a break.' },
    ],
    voice: [{ name: DEFAULT_VOICE }, { name: 'study-room' }, { name: 'quiet-study', noTalking: true }],
    notes: [
      {
        title: 'Study plan',
        text:
          '# Study plan\n\n## This week\n\n- [ ] \n\n## Exams and deadlines\n\n| What | When |\n| --- | --- |\n|  |  |\n\n' +
          '## Topics to go over\n\n- \n',
      },
    ],
  },
  {
    id: 'community',
    title: 'Club or community',
    about: 'News, events and introductions for a bigger group.',
    example: 'Book club',
    text: [
      { name: DEFAULT_CHANNEL, topic: 'Talk about anything.' },
      { name: 'announcements', topic: 'News from the people who run this space.' },
      { name: 'introductions', topic: 'New here? Tell us about yourself.' },
      { name: 'events', topic: 'What is on, and when.' },
      { name: 'off-topic', topic: 'Anything that is not about the club.' },
    ],
    voice: [{ name: DEFAULT_VOICE }, { name: 'stage', topic: 'Talks and events.', noTalking: true }],
    notes: [
      {
        title: 'Rules',
        text:
          '# Rules\n\n1. Be kind. Treat people as you want them to treat you.\n2. Keep it on topic in each channel.\n' +
          '3. No spam and no ads.\n4. Ask a moderator if you are not sure.\n',
      },
    ],
  },
  {
    id: 'team',
    title: 'Work or project team',
    about: 'Daily check-ins, ideas, and a room for meetings.',
    example: 'Project team',
    text: [
      { name: DEFAULT_CHANNEL, topic: 'Team talk.' },
      { name: 'standup', topic: 'What you did, what you do next, and what blocks you.' },
      { name: 'ideas', topic: 'Big and small.' },
      { name: 'random', topic: 'Anything that is not work.' },
    ],
    voice: [{ name: DEFAULT_VOICE }, { name: 'meeting-room' }, { name: 'focus' }],
    notes: [
      {
        title: 'Team handbook',
        text:
          '# Team handbook\n\n## Who does what\n\n- \n\n## How we work\n\n- Standup: \n- Meetings: \n\n' +
          '## Links\n\n- \n',
      },
    ],
  },
  {
    id: 'creators',
    title: 'Creator community',
    about: 'A home for your fans: news, their art, and a stage for streams.',
    example: 'The fan club',
    text: [
      { name: DEFAULT_CHANNEL, topic: 'Talk about anything.' },
      { name: 'announcements', topic: 'New videos, streams and news.' },
      { name: 'fan-art', topic: 'What you made.', mediaOnly: true },
      { name: 'suggestions', topic: 'Ideas for what comes next.' },
    ],
    voice: [{ name: DEFAULT_VOICE }, { name: 'live', topic: 'Streams and Q&A.', noTalking: true }],
    notes: [],
  },
  {
    id: 'family',
    title: 'Family',
    about: 'Photos, plans and recipes, with a call for everybody.',
    example: 'The family',
    text: [
      { name: DEFAULT_CHANNEL, topic: 'Family news.' },
      { name: 'photos', topic: 'Pictures and videos.', mediaOnly: true },
      { name: 'plans', topic: 'Birthdays, trips and visits.' },
      { name: 'recipes', topic: 'What we cook.' },
    ],
    voice: [{ name: DEFAULT_VOICE, topic: 'Family call.' }],
    notes: [],
  },
]

function newNoteId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Writes the template into a space this person just made, as if they had set it all up by hand. */
export async function applyTemplate(chat: RoomChat, template: SpaceTemplate): Promise<void> {
  const plain = { label: '', topic: '', levels: [], nsfw: false, mediaOnly: false, noTalking: false }
  for (const [list, voice] of [[template.text, false], [template.voice, true]] as const) {
    for (const channel of list) {
      // An untouched general or lounge stays as it is.
      if (!channel.topic && !channel.mediaOnly && !channel.noTalking && (channel.name === DEFAULT_CHANNEL || channel.name === DEFAULT_VOICE)) continue
      await chat.setUpChannel({ ...plain, ...channel, voice })
    }
    if (list.length > 1) await chat.orderChannels(list.map((c) => c.name), voice)
  }
  for (const note of template.notes) await chat.saveNote(newNoteId(), note.title, note.text)
}
