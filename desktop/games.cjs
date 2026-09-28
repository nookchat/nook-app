// Finds the game this computer is running, so the app can say what you are
// playing. It looks at the paths of the running programs: a game is a program
// in a store's library folder, or one of the known programs below. Only the
// name of the game goes to the page, and only while the page asks for it.

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const POLL_MS = 15_000
/** How long a Steam library's list of names is kept before it is read again. */
const STEAM_NAMES_MS = 60_000

/** Each store keeps a folder per game. The folder name is the game, unless the store says better. */
const LIBRARIES = [
  /[\\/]steamapps[\\/]common[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Epic Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]GOG Galaxy[\\/]Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]GOG Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Riot Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Ubisoft Game Launcher[\\/]games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]EA Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]XboxGames[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Rockstar Games[\\/]([^\\/]+)[\\/]/i,
]

/** In a library folder, but a launcher or a tool that runs all day, not a game. */
const NOT_GAMES = new Set(
  [
    'Steamworks Common Redistributables',
    'Steam Controller Configs',
    'SteamVR',
    'wallpaper_engine',
    'Wallpaper Engine',
    'Lossless Scaling',
    'Soundpad',
    'Voicemod',
    'OVR Toolkit',
    'fpsVR',
    'BongoCat',
    'Desktop Mate',
    'Launcher',
    'Epic Online Services',
    'EpicOnlineServices',
    'DirectXRedist',
    'Riot Client',
    'Social Club',
    'Rockstar Games Launcher',
  ].map((name) => name.toLowerCase()),
)
const NOT_GAME_PREFIXES = ['proton', 'steam linux runtime', 'steamlinuxruntime']

/**
 * Games that install outside a store's library, or have a better name than their
 * folder. By program name. `steam` is the game's Steam app id, for its picture.
 */
const PROGRAMS = new Map([
  ['overwatch', { name: 'Overwatch 2', steam: 2357570 }],
  ['wow', { name: 'World of Warcraft' }],
  ['wowclassic', { name: 'World of Warcraft Classic' }],
  ['hearthstone', { name: 'Hearthstone' }],
  ['diablo iv', { name: 'Diablo IV', steam: 2344520 }],
  ['sc2', { name: 'StarCraft II' }],
  ['sc2_x64', { name: 'StarCraft II' }],
  ['cod', { name: 'Call of Duty', steam: 1938090 }],
  ['robloxplayerbeta', { name: 'Roblox' }],
  ['robloxplayer', { name: 'Roblox' }],
  ['minecraft.windows', { name: 'Minecraft' }],
  ['osu!', { name: 'osu!' }],
  ['league of legends', { name: 'League of Legends' }],
  ['leagueclient', { name: 'League of Legends' }],
  ['valorant-win64-shipping', { name: 'VALORANT' }],
  ['fortniteclient-win64-shipping', { name: 'Fortnite' }],
  ['gta5', { name: 'Grand Theft Auto V', steam: 271590 }],
  ['gta5_enhanced', { name: 'Grand Theft Auto V', steam: 3240220 }],
  ['rocketleague', { name: 'Rocket League', steam: 252950 }],
  ['r5apex', { name: 'Apex Legends', steam: 1172470 }],
  ['r5apex_dx12', { name: 'Apex Legends', steam: 1172470 }],
  ['cs2', { name: 'Counter-Strike 2', steam: 730 }],
  ['dota2', { name: 'Dota 2', steam: 570 }],
  ['eldenring', { name: 'ELDEN RING', steam: 1245620 }],
  ['fallguys_client', { name: 'Fall Guys', steam: 1097150 }],
  ['destiny2', { name: 'Destiny 2', steam: 1085660 }],
  ['rainbowsix', { name: 'Rainbow Six Siege', steam: 359550 }],
  ['eurotrucks2', { name: 'Euro Truck Simulator 2', steam: 227300 }],
  ['terraria', { name: 'Terraria', steam: 105600 }],
  ['stardew valley', { name: 'Stardew Valley', steam: 413150 }],
  ['factorio', { name: 'Factorio', steam: 427520 }],
])

const JAVA = /^javaw?(\.exe)?$/i
/** A command line that starts with a Windows drive: a program Wine or Proton runs. */
const WINE_PROGRAM = /^[A-Za-z]:\\/

/** The name of a program without its folder or .exe, in lower case. Works on Windows and POSIX paths. */
function programName(exe) {
  return path.win32.basename(exe).replace(/\.exe$/i, '').toLowerCase()
}

function isNotGame(folder) {
  const name = folder.toLowerCase()
  return NOT_GAMES.has(name) || NOT_GAME_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * The game among these programs, as { name, steam? }, or null. `steamName` turns
 * a Steam library and one of its folders into { name, steam } as Steam knows
 * the game. `keep` is a name that wins when it still runs, so two games at once
 * do not take turns.
 */
function gameIn(programs, steamName = () => null, keep = null) {
  const found = []
  for (const { exe, line } of programs) {
    // The path, not the arguments: a shell or an editor can name a game folder without being the game.
    // Wine is the exception: its command line is the Windows program it runs.
    const text = WINE_PROGRAM.test(line) ? `${exe}\n${line}` : exe
    const known = PROGRAMS.get(programName(exe))
    if (known) {
      found.push(known)
      continue
    }
    if (JAVA.test(path.win32.basename(exe)) && /minecraft/i.test(line)) {
      found.push({ name: 'Minecraft' })
      continue
    }
    for (const library of LIBRARIES) {
      const hit = library.exec(text)
      if (!hit || isNotGame(hit[1])) continue
      const steam = /steamapps[\\/]common[\\/]/i.test(hit[0])
      found.push((steam && steamName(text.slice(0, hit.index + hit[0].search(/[\\/]common[\\/]/i)), hit[1])) || { name: hit[1] })
      break
    }
  }
  return found.find((game) => game.name === keep) ?? found[0] ?? null
}

/** Proton gives a Windows path to a Linux file: Z:\home\... is /home/... */
function localPath(p) {
  if (process.platform === 'win32' || !/^[A-Za-z]:\\/.test(p)) return p
  return p.slice(2).replace(/\\/g, '/')
}

/** Reads a Steam library's appmanifest files: the folder of each game, its name and its app id. */
function readSteamNames(steamapps) {
  const names = new Map()
  let files = []
  try {
    files = fs.readdirSync(steamapps).filter((f) => /^appmanifest_\d+\.acf$/.test(f))
  } catch {
    return names
  }
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(steamapps, file), 'utf8')
      const name = /"name"\s+"([^"]+)"/.exec(text)?.[1]
      const dir = /"installdir"\s+"([^"]+)"/.exec(text)?.[1]
      const steam = Number(/"appid"\s+"(\d+)"/.exec(text)?.[1]) || undefined
      if (name && dir) names.set(dir.toLowerCase(), { name, steam })
    } catch {
      /* a manifest Steam is writing */
    }
  }
  return names
}

function steamNamer() {
  const libraries = new Map()
  return (steamapps, folder) => {
    const dir = localPath(steamapps)
    let held = libraries.get(dir)
    if (!held || (Date.now() - held.at > STEAM_NAMES_MS && !held.names.has(folder.toLowerCase()))) {
      held = { at: Date.now(), names: readSteamNames(dir) }
      libraries.set(dir, held)
    }
    return held.names.get(folder.toLowerCase()) ?? null
  }
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
      resolve(err ? '' : String(out)),
    )
  })
}

/** Every running program: its file, and the whole command line. */
async function listPrograms() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ExecutablePath)`t$($_.CommandLine)" }',
    ])
    return out
      .split(/\r?\n/)
      .map((row) => row.split('\t'))
      .filter(([exe]) => exe)
      .map(([exe, line = '']) => ({ exe, line }))
  }
  if (process.platform === 'linux') {
    const out = []
    let pids = []
    try {
      pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))
    } catch {
      return out
    }
    for (const pid of pids) {
      try {
        const line = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
        let exe = ''
        try {
          exe = fs.readlinkSync(`/proc/${pid}/exe`)
        } catch {
          exe = line.split(' ')[0] ?? ''
        }
        if (exe || line) out.push({ exe, line })
      } catch {
        /* gone, or somebody else's */
      }
    }
    return out
  }
  // macOS: `comm` is the program's whole path, `args` the command line. Joined by process id.
  const [files, lines] = await Promise.all([run('ps', ['-axww', '-o', 'pid=,comm=']), run('ps', ['-axww', '-o', 'pid=,args='])])
  const byPid = new Map()
  for (const row of lines.split('\n')) {
    const hit = /^\s*(\d+)\s+(.*)$/.exec(row)
    if (hit) byPid.set(hit[1], hit[2])
  }
  const out = []
  for (const row of files.split('\n')) {
    const hit = /^\s*(\d+)\s+(.*)$/.exec(row)
    if (hit) out.push({ exe: hit[2], line: byPid.get(hit[1]) ?? '' })
  }
  return out
}

/** Looks every few seconds and calls `onChange` with { name, steam?, since } or null. Stop with the returned function. */
function watchGames(onChange) {
  const steamName = steamNamer()
  let now = null
  let stopped = false
  let timer = null

  const look = async () => {
    const programs = await listPrograms()
    if (stopped) return
    const game = gameIn(programs, steamName, now?.name ?? null)
    if ((game?.name ?? null) !== (now?.name ?? null)) {
      now = game ? { ...game, since: Date.now() } : null
      onChange(now)
    }
    timer = setTimeout(look, POLL_MS)
  }
  void look()

  return {
    now: () => now,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      const was = now
      now = null
      if (was) onChange(null)
    },
  }
}

module.exports = { gameIn, watchGames }
