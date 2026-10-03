import { APP_URL, answer, check, finish, launch, poll, stoppedEarly, wait } from './harness.mjs'

// A space copied from a Discord server template: its roles become levels, its channels come in
// Discord's order with who may see each, and somebody who joins sees only what their level may.
// Discord is never asked: the page's request for the template is answered here.
const browser = await launch()
const BOX = '[aria-label="Write a message"]'

const VIEW = 1n << 10n
const SEND = 1n << 11n
const SPEAK = 1n << 21n
const SOUNDBOARD = 1n << 42n
const deny = (id, bits) => ({ id, type: 0, allow: '0', deny: String(bits) })
const allow = (id, bits) => ({ id, type: 0, allow: String(bits), deny: '0' })
const channel = (id, type, name, parent, position, extra = {}) => ({
  id, type, name, parent_id: parent, position, topic: null, nsfw: false, permission_overwrites: [], ...extra,
})

const TEMPLATE = {
  code: 'nooktest',
  serialized_source_guild: {
    name: 'Pixel Pals',
    system_channel_id: 22,
    roles: [
      { id: 0, name: '@everyone', permissions: String(VIEW | SEND | SPEAK | SOUNDBOARD), color: 0 },
      { id: 1, name: 'Verified', permissions: '0', color: 0x3498db },
      { id: 2, name: 'Mods', permissions: String((1n << 13n) | (1n << 1n) | (1n << 24n)), color: 0x2ecc71 },
      { id: 3, name: 'Admins', permissions: String(1n << 3n), color: 0xe74c3c },
    ],
    channels: [
      channel(10, 4, 'Info', null, 0),
      channel(11, 4, 'Chat', null, 1),
      channel(12, 4, 'Staff', null, 2, { permission_overwrites: [deny(0, VIEW)] }),
      channel(20, 0, '📜┃rules', 10, 0, { topic: 'Read me first' }),
      channel(21, 5, 'announcements', 10, 1),
      channel(22, 0, 'welcome', 11, 0),
      channel(23, 16, 'memes', 11, 1),
      channel(24, 0, 'after-dark', 11, 2, { nsfw: true }),
      channel(25, 0, 'mod-chat', 12, 0, { permission_overwrites: [deny(0, VIEW), allow(2, VIEW)] }),
      channel(26, 0, 'general', 12, 1, { permission_overwrites: [deny(0, VIEW)] }),
      channel(27, 0, 'top', null, 5),
      channel(30, 2, 'Hangout', 11, 3),
      channel(31, 13, 'Town Hall', 11, 4),
      channel(32, 2, 'Listen Only', 11, 5, { permission_overwrites: [deny(0, SPEAK)] }),
      channel(33, 2, 'Staff VC', 12, 1, { permission_overwrites: [deny(0, VIEW)] }),
    ],
  },
}

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.route('https://discord.com/api/v10/guilds/templates/**', (route) => {
    const known = route.request().url().endsWith('/nooktest')
    route.fulfill({
      status: known ? 200 : 404,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(known ? TEMPLATE : { message: 'Unknown server template', code: 10057 }),
    })
  })
  const page = await context.newPage()
  await page.goto(APP_URL)
  await page.evaluate((n) => localStorage.setItem('nook.name.v1', n), name)
  await page.reload()
  await page.waitForSelector('input[aria-label="Space name"]')
  return page
}

const state = (page) =>
  page.evaluate(async () => {
    const { spaces } = await import('/src/space/registry.ts')
    const chat = spaces.all()[0]?.chat
    if (!chat) return null
    return {
      name: chat.spaceName(),
      text: chat.channelInfo(false),
      voice: chat.channelInfo(true),
      levels: chat.levels().map((l) => ({ id: l.id, name: l.name, colour: l.colour, rank: l.rank, can: l.can })),
    }
  })

try {
  const alice = await person('Alice')

  // A link that no longer works says so, and makes nothing.
  await alice.click('button:has-text("Copy a Discord server")')
  await answer(alice, 'https://discord.new/expired1')
  const refused = await poll(() => alice.$$eval('.toast', (els) => els.some((t) => t.textContent.includes('does not work'))), 5000)
  check('a template link that does not work says so', refused)
  check('and no space is made', (await alice.locator(BOX).count()) === 0)

  await alice.click('button:has-text("Copy a Discord server")')
  await answer(alice, 'https://discord.new/nooktest')
  await alice.waitForSelector(BOX)
  const made = await poll(async () => {
    const s = await state(alice)
    return s && s.voice.length >= 4 && s.levels.some((l) => l.name === 'Admins') ? s : null
  }, 15_000)
  check('the space takes the Discord server name', made?.name === 'Pixel Pals', made?.name)

  const names = made.text.map((c) => c.name).join(',')
  check(
    'text channels come in Discord order, outside a category first',
    names === 'top,rules,announcements,general,memes,after-dark,mod-chat,general-2',
    names,
  )
  const text = Object.fromEntries(made.text.map((c) => [c.name, c]))
  check('a name with an emoji keeps it as the label', text.rules.label === '📜┃rules' && text.rules.topic === 'Read me first')
  check("Discord's welcome channel stands in for general", text.general.label === 'welcome' && text.general.levels.length === 0)
  check('a private channel called general does not open up', text['general-2'].levels.length > 0)
  check('a media channel is Media only', text.memes.mediaOnly && !text.top.mediaOnly)
  check('an NSFW channel is NSFW', text['after-dark'].nsfw && !text.top.nsfw)

  const levels = Object.fromEntries(made.levels.map((l) => [l.name, l]))
  const order = made.levels.map((l) => l.name).join(',')
  check("Discord's roles replace Admin and Moderator, in Discord's order", order === 'Owner,Admins,Mods,Verified,Member', order)
  check('a role keeps its colour', levels.Mods.colour === '#2ecc71' && levels.Verified.colour === '#3498db')
  check('Administrator can do everything', levels.Admins.can.length === levels.Owner.can.length)
  check(
    'a role can do what its Discord powers say',
    ['delete', 'move', 'pin', 'relocate', 'remove', 'soundboard'].every((p) => levels.Mods.can.includes(p)) && !levels.Mods.can.includes('channels'),
    levels.Mods.can.join(','),
  )
  check('Member can do what @everyone could', levels.Member.can.join(',') === 'soundboard', levels.Member.can.join(','))
  const modChat = text['mod-chat'].levels
  check('a private channel is kept to the roles that saw it', modChat.includes(levels.Mods.id) && modChat.includes(levels.Admins.id) && !modChat.includes(levels.Verified.id))

  const voice = Object.fromEntries(made.voice.map((c) => [c.name, c]))
  const voices = made.voice.map((c) => c.name).join(',')
  check('voice channels come in order, the first open one as lounge', voices === 'lounge,town-hall,listen-only,staff-vc', voices)
  check('a stage channel is No talking', voice['town-hall'].noTalking && voice['town-hall'].label === 'Town Hall')
  check('a voice channel where @everyone may not speak is No talking', voice['listen-only'].noTalking && !voice.lounge.noTalking)
  check('a private voice channel is kept', voice['staff-vc'].levels.length > 0)
  await alice.screenshot({ path: 'test-output/discord-owner.png' })

  // Somebody who joins is a Member, and sees only the open channels.
  const bob = await person('Bob')
  await bob.goto(alice.url())
  await bob.waitForSelector(BOX)
  const seen = await poll(async () => {
    const rows = await bob.$$eval('.rail-left .rail-item', (els) => els.map((e) => e.textContent.trim()))
    return rows.some((r) => r.includes('Hangout')) ? rows : null
  }, 20_000)
  const all = (seen ?? []).join(' | ')
  check('somebody new sees the open channels by their Discord names', all.includes('welcome') && all.includes('Hangout'), all)
  check('and not the kept ones', !all.includes('mod-chat') && !all.includes('Staff VC'), all)
  await bob.screenshot({ path: 'test-output/discord-member.png' })
  await wait(500)
} catch (err) {
  stoppedEarly(err)
} finally {
  await browser.close()
  finish()
}
