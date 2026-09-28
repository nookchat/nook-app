import { createRequire } from 'node:module'
import { check, finish } from './harness.mjs'

// The desktop shell's game finder, on its own: it reads program paths, so no browser is needed.
const { gameIn } = createRequire(import.meta.url)('../desktop/games.cjs')
/** Just the name, for most checks. */
const nameIn = (...args) => gameIn(...args)?.name ?? null

const run = (...exes) => exes.map((exe) => ({ exe, line: exe }))
const steam = (dir, folder) => (folder === 'Counter-Strike Global Offensive' ? { name: 'Counter-Strike 2', steam: 730 } : null)

check('nothing running is no game', nameIn([]) === null)
check('a browser and the Steam client are no game', nameIn(run('C:\\Program Files\\Google\\Chrome\\chrome.exe', 'C:\\Program Files (x86)\\Steam\\steam.exe')) === null)
check(
  'a game in a Steam library on Windows',
  nameIn(run('D:\\SteamLibrary\\steamapps\\common\\Hades II\\Ship\\Hades2.exe')) === 'Hades II',
)
check(
  'Steam says the name when the folder is old',
  nameIn(run('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\csgo.exe'), steam) ===
    'Counter-Strike 2',
)
check(
  'a game in a Steam library on macOS',
  nameIn(run('/Users/a/Library/Application Support/Steam/steamapps/common/Balatro/Balatro.app/Contents/MacOS/love')) === 'Balatro',
)
check(
  'a Proton game on Linux',
  nameIn([{ exe: '/usr/bin/wine64-preloader', line: 'Z:\\home\\a\\.local\\share\\Steam\\steamapps\\common\\ELDEN RING\\Game\\start.exe' }]) === 'ELDEN RING',
)
check(
  'a shell that names a game folder is no game',
  nameIn([{ exe: '/bin/zsh', line: 'zsh -c ls ~/Library/Application Support/Steam/steamapps/common/Balatro/' }]) === null,
)
check('Proton itself is no game', nameIn(run('/home/a/.steam/steam/steamapps/common/Proton 9.0 (Beta)/files/bin/wineserver')) === null)
check('Wallpaper Engine is no game', nameIn(run('C:\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe')) === null)
check('the Epic launcher is no game', nameIn(run('C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe')) === null)
check('the Riot client is no game', nameIn(run('C:\\Riot Games\\Riot Client\\RiotClientServices.exe')) === null)
check('a known program by name', nameIn(run('C:\\Program Files (x86)\\Overwatch\\_retail_\\Overwatch.exe')) === 'Overwatch 2')
check('Roblox on macOS', nameIn(run('/Applications/Roblox.app/Contents/MacOS/RobloxPlayer')) === 'Roblox')
check(
  'Minecraft is java with minecraft in the command line',
  nameIn([{ exe: 'C:\\x\\runtime\\bin\\javaw.exe', line: 'javaw.exe -cp net.minecraft.client.main.Main' }]) === 'Minecraft',
)
check('plain java is no game', nameIn([{ exe: '/usr/bin/java', line: 'java -jar build-server.jar' }]) === null)
const both = run('C:\\Steam\\steamapps\\common\\Terraria\\Terraria.exe', 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe')
check('two games: the one already shown stays', nameIn(both, undefined, 'VALORANT') === 'VALORANT')
check('two games: the first when none is shown', nameIn(both) === 'Terraria')

const csgo = gameIn(run('C:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\cs2x.exe'), steam)
check('a Steam game carries its app id, for its picture', csgo?.steam === 730, JSON.stringify(csgo))
check('a known program carries its app id too', gameIn(run('C:\\Games\\Terraria\\Terraria.exe'))?.steam === 105600)
check('a game not on Steam has no app id', gameIn(run('C:\\Riot Games\\VALORANT\\live\\VALORANT.exe'))?.steam === undefined)

finish()
