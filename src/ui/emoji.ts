import { h, clear } from './dom'

interface EmojiGroup {
  id: string
  label: string
  tab: string
  /** "<emoji> <keywords>" */
  items: string[]
}

const GROUPS: EmojiGroup[] = [
  {
    id: 'faces',
    label: 'Smileys',
    tab: '😀',
    items: [
      '😀 grin happy smile', '😃 smiley happy joy', '😄 laugh happy grin',
      '😁 beam grin teeth', '😆 laugh squint haha', '😅 sweat laugh relief',
      '🤣 rofl laugh floor', '😂 joy laugh cry tears', '🙂 smile slight',
      '🙃 upside silly', '😉 wink', '😊 blush smile warm', '😇 innocent halo angel',
      '🥰 love hearts adore', '😍 heart eyes love', '🤩 star struck wow',
      '😘 kiss blow', '😗 kissing', '😚 kiss closed', '😋 yum tasty tongue',
      '😛 tongue cheeky', '😜 wink tongue joke', '🤪 zany goofy wild',
      '🤨 eyebrow suspicious doubt', '🧐 monocle inspect posh', '🤓 nerd glasses geek',
      '😎 cool sunglasses', '🥳 party celebrate birthday', '😏 smirk sly',
      '😒 unamused meh', '😞 sad disappointed', '😔 pensive sad quiet',
      '😟 worried', '😕 confused unsure', '🙁 frown slight sad', '😣 persevere struggle',
      '😖 confounded', '😫 tired fed up', '😩 weary done', '🥺 pleading puppy please',
      '😢 cry sad tear', '😭 sob crying loud', '😤 triumph huff steam',
      '😠 angry cross', '😡 rage furious mad', '🤬 swearing censored',
      '🤯 mind blown explode', '😳 flushed embarrassed', '🥵 hot heat sweating',
      '🥶 cold freezing', '😱 scream fear shock', '😨 fearful scared',
      '😰 anxious sweat', '😥 sad relieved', '🤗 hug hugging', '🤔 thinking hmm',
      '🤭 oops giggle', '🤫 shush quiet secret', '🤥 lying pinocchio',
      '😶 no mouth blank', '😐 neutral straight', '😑 expressionless',
      '😬 grimace awkward yikes', '🙄 eye roll whatever', '😯 hushed surprise',
      '😲 astonished shock', '🥱 yawn bored tired', '😴 sleeping zzz',
      '🤤 drool', '😪 sleepy tear', '😵 dizzy knocked out', '🤐 zipper quiet',
      '🥴 woozy drunk', '🤢 sick nausea', '🤮 vomit sick', '🤧 sneeze cold',
      '😷 mask sick', '🤒 thermometer ill', '🤕 bandage hurt', '🤑 money mouth rich',
      '🤠 cowboy yeehaw', '😈 devil mischief', '👿 imp angry devil',
      '💀 skull dead', '☠️ skull crossbones', '👻 ghost boo', '👽 alien ufo',
      '🤖 robot bot', '💩 poop', '🤡 clown', '👹 ogre', '🎃 pumpkin halloween',
    ],
  },
  {
    id: 'people',
    label: 'People',
    tab: '👋',
    items: [
      '👍 thumbs up yes good ok', '👎 thumbs down no bad', '👌 ok perfect fine',
      '🤌 pinched italian chef', '✌️ peace victory', '🤞 crossed fingers luck',
      '🤟 love you', '🤘 rock horns', '🤙 call me shaka', '👈 point left',
      '👉 point right', '👆 point up', '👇 point down', '☝️ point up index',
      '✋ hand stop high five', '🤚 raised back hand', '🖐️ splayed hand',
      '🖖 vulcan spock', '👋 wave hello hi bye', '🤝 handshake deal agree',
      '🙏 pray thanks please', '✍️ writing hand', '💪 muscle strong flex',
      '🦾 mechanical arm', '👏 clap applause well done', '🙌 raised hands praise',
      '👐 open hands', '🤲 palms up', '🤜 fist right', '🤛 fist left',
      '✊ fist raised', '👊 fist bump punch', '🖕 middle finger',
      '💅 nails polish', '🤳 selfie', '👀 eyes look watching', '👁️ eye',
      '🧠 brain smart', '🫀 heart organ', '👶 baby', '🧒 child',
      '👦 boy', '👧 girl', '🧑 person', '👨 man', '👩 woman',
      '🧓 older person', '👴 old man', '👵 old woman', '🙋 raising hand me',
      '🙅 no gesture stop', '🙆 ok gesture', '💁 tipping hand sassy info',
      '🙇 bow sorry apology', '🤦 facepalm', '🤷 shrug dunno idk',
      '🧑‍💻 technologist coder dev', '🕺 dancing man', '💃 dancing woman',
      '🧘 meditate yoga calm', '🏃 running run', '🚶 walking',
      '👮 police cop', '🕵️ detective spy', '👷 construction worker',
      '🤴 prince', '👸 princess', '🦸 superhero', '🦹 supervillain',
      '🎅 santa christmas', '🧙 wizard mage', '🧛 vampire', '🧟 zombie',
      '👤 silhouette person', '👥 people group', '👪 family',
    ],
  },
  {
    id: 'nature',
    label: 'Nature',
    tab: '🐻',
    items: [
      '🐶 dog puppy', '🐱 cat kitten', '🐭 mouse', '🐹 hamster', '🐰 rabbit bunny',
      '🦊 fox', '🐻 bear', '🐼 panda', '🐨 koala', '🐯 tiger', '🦁 lion',
      '🐮 cow', '🐷 pig', '🐸 frog', '🐵 monkey', '🙈 see no evil monkey',
      '🙉 hear no evil monkey', '🙊 speak no evil monkey', '🐒 monkey',
      '🐔 chicken', '🐧 penguin', '🐦 bird', '🐤 chick', '🦆 duck', '🦅 eagle',
      '🦉 owl', '🦇 bat', '🐺 wolf', '🐗 boar', '🐴 horse', '🦄 unicorn',
      '🐝 bee', '🐛 bug caterpillar', '🦋 butterfly', '🐌 snail slow',
      '🐞 ladybird', '🐜 ant', '🦗 cricket', '🕷️ spider', '🦂 scorpion',
      '🐢 turtle', '🐍 snake', '🦎 lizard', '🦖 t-rex dinosaur', '🐙 octopus',
      '🦑 squid', '🦐 shrimp', '🦀 crab', '🐡 blowfish', '🐠 tropical fish',
      '🐟 fish', '🐬 dolphin', '🐳 whale', '🦈 shark', '🐊 crocodile',
      '🐘 elephant', '🦏 rhino', '🐪 camel', '🦒 giraffe', '🐄 cow',
      '🐕 dog', '🐩 poodle', '🐈 cat', '🐓 rooster', '🦃 turkey',
      '🌵 cactus', '🎄 christmas tree', '🌲 evergreen tree', '🌳 tree',
      '🌴 palm tree', '🌱 seedling sprout', '🌿 herb leaves', '☘️ shamrock',
      '🍀 four leaf clover luck', '🍁 maple leaf', '🍂 fallen leaves autumn',
      '🍃 leaf wind', '🌺 hibiscus flower', '🌻 sunflower', '🌹 rose',
      '🌷 tulip', '🌸 blossom sakura', '💐 bouquet flowers', '🌾 wheat',
      '🌍 earth globe world', '🌙 moon night', '⭐ star', '🌟 glowing star',
      '✨ sparkles shiny magic', '⚡ lightning bolt fast', '🔥 fire lit hot',
      '💧 droplet water', '🌊 wave ocean', '❄️ snowflake cold', '☀️ sun sunny',
      '⛅ partly cloudy', '☁️ cloud', '🌧️ rain', '🌈 rainbow',
    ],
  },
  {
    id: 'food',
    label: 'Food',
    tab: '🍔',
    items: [
      '🍏 green apple', '🍎 apple', '🍐 pear', '🍊 orange', '🍋 lemon',
      '🍌 banana', '🍉 watermelon', '🍇 grapes', '🍓 strawberry',
      '🫐 blueberries', '🍈 melon', '🍒 cherries', '🍑 peach', '🥭 mango',
      '🍍 pineapple', '🥥 coconut', '🥝 kiwi', '🍅 tomato', '🥑 avocado',
      '🥦 broccoli', '🥬 leafy green', '🥒 cucumber', '🌶️ chilli hot pepper',
      '🌽 corn', '🥕 carrot', '🧄 garlic', '🧅 onion', '🥔 potato',
      '🍠 sweet potato', '🥐 croissant', '🥖 baguette bread', '🍞 bread toast',
      '🥨 pretzel', '🧀 cheese', '🥚 egg', '🍳 fried egg cooking',
      '🥞 pancakes', '🧇 waffle', '🥓 bacon', '🍔 burger', '🍟 chips fries',
      '🌭 hot dog', '🍕 pizza', '🥪 sandwich', '🌮 taco', '🌯 burrito',
      '🥙 wrap', '🧆 falafel', '🥗 salad', '🥘 pan food', '🍝 pasta spaghetti',
      '🍜 noodles ramen', '🍲 stew soup', '🍛 curry', '🍣 sushi',
      '🍱 bento', '🥟 dumpling', '🍤 prawn tempura', '🍚 rice', '🍙 rice ball',
      '🍢 oden', '🍡 dango', '🍦 ice cream', '🍧 shaved ice', '🍨 ice cream bowl',
      '🍩 doughnut', '🍪 biscuit cookie', '🎂 birthday cake', '🍰 cake slice',
      '🧁 cupcake', '🥧 pie', '🍫 chocolate', '🍬 sweet candy', '🍭 lollipop',
      '🍯 honey', '🥛 milk', '☕ coffee tea', '🍵 green tea', '🧃 juice box',
      '🥤 soft drink cup', '🍺 beer pint', '🍻 beers cheers', '🥂 champagne cheers',
      '🍷 wine', '🥃 whisky', '🍸 cocktail martini', '🍹 tropical drink',
      '🧊 ice cube', '🍾 bottle pop celebrate', '🥄 spoon', '🍴 fork knife',
    ],
  },
  {
    id: 'activity',
    label: 'Activity',
    tab: '⚽',
    items: [
      '⚽ football soccer', '🏀 basketball', '🏈 american football',
      '⚾ baseball', '🥎 softball', '🎾 tennis', '🏐 volleyball', '🏉 rugby',
      '🥏 frisbee', '🎱 pool eight ball', '🏓 table tennis ping pong',
      '🏸 badminton', '🥅 goal net', '🏒 ice hockey', '🏑 field hockey',
      '🥍 lacrosse', '🏏 cricket', '⛳ golf', '🏹 archery bow', '🎣 fishing',
      '🥊 boxing gloves', '🥋 martial arts', '⛸️ ice skate', '🎿 ski',
      '🛷 sledge', '🏂 snowboard', '🏋️ weight lifting gym', '🤸 cartwheel',
      '🤺 fencing', '🤼 wrestling', '🤽 water polo', '🏄 surfing',
      '🏊 swimming', '🚴 cycling bike', '🚵 mountain biking', '🧗 climbing',
      '🏆 trophy win first', '🥇 gold medal first', '🥈 silver medal second',
      '🥉 bronze medal third', '🎖️ military medal', '🏅 sports medal',
      '🎯 target bullseye', '🎮 game controller gaming', '🕹️ joystick arcade',
      '🎲 dice random', '♟️ chess pawn', '🧩 puzzle piece', '🎰 slot machine',
      '🎳 bowling', '🎨 art painting', '🎬 clapper film movie', '🎤 microphone sing',
      '🎧 headphones listening', '🎵 music note', '🎶 music notes',
      '🎹 piano keyboard', '🥁 drum', '🎸 guitar', '🎺 trumpet', '🎻 violin',
      '🎪 circus tent', '🎭 theatre masks drama', '🎟️ ticket', '🎫 ticket admit',
      '🎉 party popper celebrate hooray', '🎊 confetti ball', '🎈 balloon',
      '🎁 gift present', '🎀 ribbon bow', '🪄 magic wand', '🔮 crystal ball',
    ],
  },
  {
    id: 'travel',
    label: 'Travel',
    tab: '✈️',
    items: [
      '🚗 car', '🚕 taxi', '🚙 suv', '🚌 bus', '🚎 trolleybus', '🏎️ racing car',
      '🚓 police car', '🚑 ambulance', '🚒 fire engine', '🚐 minibus van',
      '🚚 lorry truck', '🚛 articulated lorry', '🚜 tractor', '🛵 scooter',
      '🏍️ motorcycle', '🛴 kick scooter', '🚲 bicycle bike', '🛺 rickshaw',
      '🚨 siren emergency alert', '🚔 police car', '🚍 oncoming bus',
      '🚅 bullet train', '🚄 high speed train', '🚂 steam locomotive',
      '🚆 train', '🚇 metro underground', '🚊 tram', '🚝 monorail',
      '🚁 helicopter', '✈️ aeroplane flight', '🛫 take off departure',
      '🛬 landing arrival', '🪂 parachute', '💺 seat', '🚀 rocket launch ship',
      '🛸 flying saucer ufo', '🛶 canoe', '⛵ sailing boat', '🚤 speedboat',
      '🛳️ passenger ship', '⛴️ ferry', '🚢 ship', '⚓ anchor',
      '🗺️ world map', '🧭 compass', '🏔️ snowy mountain', '⛰️ mountain',
      '🌋 volcano', '🏕️ camping', '🏖️ beach', '🏜️ desert', '🏝️ desert island',
      '🏟️ stadium', '🏛️ classical building', '🏗️ construction',
      '🏘️ houses', '🏠 house home', '🏡 house garden', '🏢 office building',
      '🏣 post office', '🏥 hospital', '🏦 bank', '🏨 hotel', '🏪 shop store',
      '🏫 school', '🏭 factory', '🏰 castle', '🗼 tower', '🗽 statue liberty',
      '⛪ church', '🕌 mosque', '🛕 temple', '🕍 synagogue', '⛲ fountain',
      '⛺ tent', '🌁 foggy', '🌃 night city', '🏙️ cityscape', '🌇 sunset city',
      '🌉 bridge night', '🎡 ferris wheel', '🎢 rollercoaster', '🎠 carousel',
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
    tab: '💡',
    items: [
      '💻 laptop computer', '🖥️ desktop computer', '🖨️ printer',
      '⌨️ keyboard', '🖱️ mouse', '💽 minidisc', '💾 floppy disk save',
      '💿 cd', '📀 dvd', '🧮 abacus', '📱 phone mobile', '☎️ telephone',
      '📞 phone receiver call', '📟 pager', '📠 fax', '🔋 battery',
      '🔌 plug power', '💡 light bulb idea', '🔦 torch flashlight',
      '🕯️ candle', '🧯 fire extinguisher', '🛢️ oil drum', '💸 money wings',
      '💵 dollars cash', '💴 yen', '💶 euro', '💷 pounds', '💰 money bag',
      '💳 card payment', '🧾 receipt', '⚖️ scales balance justice',
      '🔧 spanner wrench fix', '🔨 hammer', '⚒️ hammer pick', '🛠️ tools',
      '⛏️ pick', '🔩 nut bolt', '⚙️ gear settings cog', '🧰 toolbox',
      '🧲 magnet', '🔫 water pistol', '💣 bomb', '🧨 firecracker',
      '🔪 knife', '🗡️ dagger', '⚔️ crossed swords', '🛡️ shield',
      '🚬 cigarette', '⚰️ coffin', '🏺 amphora', '🔭 telescope',
      '🔬 microscope', '🕳️ hole', '💊 pill medicine', '💉 syringe injection',
      '🩹 plaster bandage', '🩺 stethoscope', '🚪 door', '🛏️ bed',
      '🛋️ sofa couch', '🪑 chair', '🚽 toilet', '🚿 shower', '🛁 bath',
      '🧴 lotion bottle', '🧷 safety pin', '🧹 broom', '🧺 basket',
      '🧻 toilet roll', '🧼 soap', '🧽 sponge', '🔑 key', '🗝️ old key',
      '🔒 locked private', '🔓 unlocked open', '🔐 locked with key',
      '📦 package box', '📫 postbox', '📮 postbox', '📜 scroll',
      '📄 page document', '📃 page curl', '📑 bookmark tabs', '📊 bar chart',
      '📈 chart up growth', '📉 chart down loss', '📇 card index',
      '🗂️ dividers', '📋 clipboard', '📌 pin', '📍 round pin location',
      '📎 paperclip', '🖇️ paperclips', '📏 ruler', '📐 set square',
      '✂️ scissors cut', '🗑️ bin rubbish delete', '🔍 search magnifying find',
      '🔎 search zoom', '📚 books', '📖 open book read', '📕 closed book',
      '📓 notebook', '📔 notebook decorated', '📝 memo note write',
      '✏️ pencil', '🖊️ pen', '🖋️ fountain pen', '🖌️ paintbrush',
      '🖍️ crayon', '📆 calendar date', '📅 calendar', '⏰ alarm clock',
      '⏱️ stopwatch', '⌛ hourglass done', '⏳ hourglass waiting',
      '⌚ watch', '📡 satellite dish', '🔔 bell notification', '🔕 bell off mute',
      '📢 loudspeaker announce', '📣 megaphone shout', '📺 tv', '📻 radio',
      '📷 camera photo', '📸 camera flash', '📹 video camera', '🎥 movie camera',
      '🔗 link chain', '🧵 thread', '🪛 screwdriver', '🪟 window',
    ],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    tab: '❤️',
    items: [
      '❤️ red heart love', '🧡 orange heart', '💛 yellow heart', '💚 green heart',
      '💙 blue heart', '💜 purple heart', '🖤 black heart', '🤍 white heart',
      '🤎 brown heart', '💔 broken heart', '❣️ heart exclamation',
      '💕 two hearts', '💞 revolving hearts', '💓 beating heart',
      '💗 growing heart', '💖 sparkling heart', '💘 heart arrow cupid',
      '💝 heart ribbon gift', '💟 heart decoration', '☮️ peace',
      '✝️ cross', '☪️ star crescent', '🕉️ om', '☸️ dharma wheel',
      '✡️ star of david', '🔯 six pointed star', '☯️ yin yang',
      '⚛️ atom science', '♈ aries', '♉ taurus', '♊ gemini', '♋ cancer',
      '♌ leo', '♍ virgo', '♎ libra', '♏ scorpio', '♐ sagittarius',
      '♑ capricorn', '♒ aquarius', '♓ pisces', '🆔 id', '⚠️ warning caution',
      '🚸 children crossing', '⛔ no entry', '🚫 prohibited no', '🚳 no bikes',
      '🚭 no smoking', '☢️ radioactive', '☣️ biohazard', '⬆️ up arrow',
      '↗️ up right arrow', '➡️ right arrow', '↘️ down right arrow',
      '⬇️ down arrow', '↙️ down left arrow', '⬅️ left arrow',
      '↖️ up left arrow', '↕️ up down arrow', '↔️ left right arrow',
      '↩️ right hook return reply', '↪️ left hook forward', '🔃 clockwise refresh',
      '🔄 arrows counterclockwise refresh sync', '🔙 back', '🔚 end',
      '🔛 on', '🔝 top up', '🔜 soon', '🛐 place of worship',
      '🔀 shuffle', '🔁 repeat loop', '🔂 repeat one', '▶️ play',
      '⏩ fast forward', '⏭️ next track skip', '⏯️ play pause', '◀️ reverse play',
      '⏪ rewind', '⏮️ previous track', '🔼 up button', '⏫ fast up',
      '🔽 down button', '⏬ fast down', '⏸️ pause', '⏹️ stop', '⏺️ record',
      '⏏️ eject', '🎦 cinema', '🔅 dim', '🔆 bright', '📶 signal bars',
      '📳 vibration', '📴 phone off', '♻️ recycle', '⚜️ fleur de lis',
      '🔱 trident', '📛 name badge', '🔰 beginner', '⭕ hollow circle',
      '✅ tick check done yes', '☑️ ballot tick', '✔️ tick', '❌ cross no wrong',
      '❎ cross mark button', '➕ plus add', '➖ minus', '➗ divide',
      '✖️ multiply', '💯 hundred perfect score', '🔠 letters', '🔡 lowercase',
      '🔢 numbers', '🔣 symbols', '🔤 abc', '🅰️ a button', '🆎 ab button',
      '🅱️ b button', '🆑 cl button', '🆒 cool button', '🆓 free',
      '🆕 new', '🆖 ng', '🅾️ o button', '🆗 ok button', '🆘 sos help',
      '🆙 up button', '🆚 versus vs', '❓ question', '❔ white question',
      '❗ exclamation important', '❕ white exclamation', '‼️ double exclamation',
      '⁉️ exclamation question', '〰️ wavy dash', '💤 zzz sleep',
      '💢 anger symbol', '💬 speech balloon comment', '👁️‍🗨️ eye speech',
      '🗨️ left speech', '🗯️ anger balloon', '💭 thought balloon',
      '🕐 one oclock', '🕑 two oclock', '🕒 three oclock',
    ],
  },
]

interface Emoji {
  ch: string
  words: string
}

const ALL: { group: EmojiGroup; list: Emoji[] }[] = GROUPS.map((group) => ({
  group,
  list: group.items.map((raw) => {
    const space = raw.indexOf(' ')
    return space === -1
      ? { ch: raw, words: '' }
      : { ch: raw.slice(0, space), words: raw.slice(space + 1) }
  }),
}))

const WORDS_OF = new Map<string, string>()
for (const { list } of ALL) for (const e of list) if (!WORDS_OF.has(e.ch)) WORDS_OF.set(e.ch, e.words)

const SLACK_ALIASES: Record<string, string> = {
  joy: '😂', laughing: '😆', laugh: '😆', rofl: '🤣', smile: '😄', grin: '😁', grinning: '😀',
  sweat_smile: '😅', wink: '😉', blush: '😊', heart_eyes: '😍', kissing_heart: '😘', thinking: '🤔',
  sob: '😭', cry: '😢', angry: '😠', rage: '😡', scream: '😱', sunglasses: '😎', nerd: '🤓',
  upside_down: '🙃', eyes: '👀', skull: '💀', poop: '💩', ghost: '👻', shrug: '🤷', facepalm: '🤦',
  heart: '❤️', broken_heart: '💔', fire: '🔥', tada: '🎉', party: '🥳', sparkles: '✨', star: '⭐',
  '100': '💯', rocket: '🚀', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', ok_hand: '👌',
  clap: '👏', pray: '🙏', wave: '👋', muscle: '💪', raised_hands: '🙌', point_up: '☝️', v: '✌️',
  handshake: '🤝', white_check_mark: '✅', check: '✅', x: '❌', warning: '⚠️', zap: '⚡', boom: '💥',
  coffee: '☕', beer: '🍺', pizza: '🍕', cake: '🎂', see_no_evil: '🙈', sleeping: '😴', yawn: '🥱',
}

const SHORTCODES: Map<string, string> = (() => {
  const out = new Map<string, string>()
  for (const { list } of ALL) {
    for (const e of list) {
      for (const word of e.words.split(/\s+/)) if (word && !out.has(word)) out.set(word, e.ch)
    }
  }
  for (const [code, ch] of Object.entries(SLACK_ALIASES)) out.set(code, ch)
  return out
})()

export function emojiFor(code: string): string | null {
  return SHORTCODES.get(code.toLowerCase()) ?? null
}

export function emojiStartingWith(typed: string, most = 8): { code: string; ch: string }[] {
  const wanted = typed.toLowerCase()
  const seen = new Set<string>()
  const out: { code: string; ch: string }[] = []
  const exact = SHORTCODES.get(wanted)
  if (exact) {
    out.push({ code: wanted, ch: exact })
    seen.add(exact)
  }
  for (const [code, ch] of SHORTCODES) {
    if (out.length >= most) break
    if (!code.startsWith(wanted) || seen.has(ch)) continue
    seen.add(ch)
    out.push({ code, ch })
  }
  return out
}

export function withEmoji(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/:([a-z0-9_+-]{1,32}):/gi, (all, code: string) => emojiFor(code) ?? all)))
    .join('')
}

const RECENT_KEY = 'nook.emoji.v1'
const RECENT_MAX = 24

export function recentEmoji(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

function noteEmoji(ch: string): void {
  try {
    const next = [ch, ...recentEmoji().filter((e) => e !== ch)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {}
}

const QUICK_KEY = 'nook.quick.v1'

/** Empty means: fall back to the recent emoji. */
export function quickReactions(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(QUICK_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 5)
  } catch {
    return []
  }
}

export function setQuickReactions(list: string[]): void {
  try {
    localStorage.setItem(QUICK_KEY, JSON.stringify(list.filter(Boolean).slice(0, 5)))
  } catch {}
}

function describe(ch: string): string {
  return WORDS_OF.get(ch) ?? ''
}

let open: { close: () => void; anchor: HTMLElement } | null = null

export function closeEmojiPicker(): void {
  open?.close()
}

interface PickerOptions {
  anchor: HTMLElement
  onPick(ch: string): void
  title?: string
  sticky?: boolean
}

function emojiCell(ch: string): HTMLElement {
  const label = describe(ch) || ch
  // No listeners here: the grid listens once for all of them.
  return h('button', { class: 'emoji-cell', text: ch, title: label, ariaLabel: label })
}

function emojiSection(label: string, list: string[]): HTMLElement {
  const row = h('div', { class: 'emoji-row' })
  for (const ch of list) row.append(emojiCell(ch))
  return h('div', { class: 'emoji-section' }, [h('div', { class: 'emoji-head', text: label }), row])
}

/** Every group, built once and moved into whichever picker is open. */
let groupSections: HTMLElement[] | null = null

function sections(): HTMLElement[] {
  groupSections ??= ALL.map(({ group, list }) => emojiSection(group.label, list.map((e) => e.ch)))
  return groupSections
}

/** Builds the picker's insides while nothing else is happening, so the first open is quick. */
export function warmEmoji(): void {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
  if (idle) idle(() => sections())
  else window.setTimeout(() => sections(), 1500)
}

export function openEmojiPicker(options: PickerOptions): void {
  if (open && open.anchor === options.anchor) {
    open.close()
    return
  }
  open?.close()

  const search = h('input', {
    type: 'text',
    class: 'emoji-search',
    ariaLabel: 'Search emoji',
    placeholder: 'Search',
  })
  const grid = h('div', { class: 'emoji-grid' })
  const preview = h('div', { class: 'emoji-foot' })
  const tabs = h('div', { class: 'emoji-tabs' })

  const pop = h('div', { class: 'emoji-pop', role: 'dialog', ariaLabel: 'Emoji' }, [
    options.title ? h('div', { class: 'emoji-title tiny faint', text: options.title }) : null,
    search,
    tabs,
    grid,
    preview,
  ])

  const setPreview = (ch: string): void => {
    clear(preview)
    preview.append(
      h('span', { class: 'emoji-preview', text: ch }),
      h('span', { class: 'truncate tiny faint', text: ch ? describe(ch) : 'Pick one' }),
    )
  }

  const pick = (ch: string): void => {
    noteEmoji(ch)
    options.onPick(ch)
    if (options.sticky) paint(search.value)
    else close()
  }

  const cellAt = (target: EventTarget | null): HTMLElement | null => {
    const hit = (target as Element | null)?.closest?.('.emoji-cell')
    return hit instanceof HTMLElement && grid.contains(hit) ? hit : null
  }
  grid.addEventListener('click', (ev) => {
    const hit = cellAt(ev.target)
    if (hit?.textContent) pick(hit.textContent)
  })
  grid.addEventListener('mouseover', (ev) => {
    const hit = cellAt(ev.target)
    if (hit?.textContent) setPreview(hit.textContent)
  })
  grid.addEventListener('focusin', (ev) => {
    const hit = cellAt(ev.target)
    if (hit?.textContent) setPreview(hit.textContent)
  })

  const section = (label: string, list: string[]): void => {
    if (list.length === 0) return
    grid.append(emojiSection(label, list))
  }

  function paint(query: string): void {
    clear(grid)
    const q = query.trim().toLowerCase()
    if (q) {
      const hits: string[] = []
      for (const { list } of ALL) {
        for (const e of list) {
          if (e.ch === q || e.words.includes(q)) hits.push(e.ch)
          if (hits.length >= 120) break
        }
        if (hits.length >= 120) break
      }
      section(hits.length ? 'Matches' : 'Nothing matches that', hits)
      return
    }
    section('Recent', recentEmoji())
    grid.append(...sections())
  }

  for (const { group } of ALL) {
    tabs.append(
      h('button', {
        class: 'emoji-tab',
        text: group.tab,
        title: group.label,
        ariaLabel: group.label,
        on: {
          click: () => {
            search.value = ''
            paint('')
            const heads = [...grid.querySelectorAll('.emoji-head')]
            const head = heads.find((el) => el.textContent === group.label)
            if (head instanceof HTMLElement) head.scrollIntoView({ block: 'start' })
          },
        },
      }),
    )
  }

  search.addEventListener('input', () => paint(search.value))
  search.addEventListener('keydown', (ev) => {
    const key = ev.key
    if (key === 'Enter') {
      const first = grid.querySelector('.emoji-cell')
      if (first instanceof HTMLElement) first.click()
      ev.preventDefault()
      return
    }
    if (key === 'ArrowDown') {
      const first = grid.querySelector('.emoji-cell')
      if (first instanceof HTMLElement) first.focus()
      ev.preventDefault()
    }
  })

  grid.addEventListener('keydown', (ev) => {
    const key = ev.key
    if (!key.startsWith('Arrow')) return
    const cells = [...grid.querySelectorAll('.emoji-cell')].filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    )
    const at = cells.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    const perRow = Math.max(1, Math.round(grid.clientWidth / (cells[0].offsetWidth || 30)))
    const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'ArrowDown' ? perRow : -perRow
    const next = cells[at + step]
    if (next) next.focus()
    else if (step < 0) search.focus()
    ev.preventDefault()
  })

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    close()
    options.anchor.focus()
  }
  const onDown = (ev: Event): void => {
    const target = ev.target as Node
    if (pop.contains(target) || options.anchor.contains(target)) return
    close()
  }

  function close(): void {
    if (open?.close !== close) return
    open = null
    pop.remove()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('resize', close)
  }

  open = { close, anchor: options.anchor }
  setPreview('')
  paint('')
  document.body.append(pop)
  placeNear(pop, options.anchor)

  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('resize', close)
  search.focus()
}

export function placeNear(pop: HTMLElement, anchor: HTMLElement): void {
  const at = anchor.getBoundingClientRect()
  const box = pop.getBoundingClientRect()
  const margin = 6

  let top = at.bottom + margin
  if (top + box.height > window.innerHeight - margin) {
    top = at.top - box.height - margin
  }
  if (top < margin) top = Math.max(margin, window.innerHeight - box.height - margin)

  let left = at.left
  if (left + box.width > window.innerWidth - margin) left = window.innerWidth - box.width - margin
  if (left < margin) left = margin

  pop.style.top = `${Math.round(top)}px`
  pop.style.left = `${Math.round(left)}px`
}
