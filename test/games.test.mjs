import { createRequire } from 'node:module'
import { check, finish } from './harness.mjs'

// The desktop shell's game finder, on its own: it reads program paths, so no browser is needed.
const { gameIn } = createRequire(import.meta.url)('../desktop/games.cjs')

const run = (...exes) => exes.map((exe) => ({ exe, line: exe }))
const steam = (dir, folder) => (folder === 'Counter-Strike Global Offensive' ? 'Counter-Strike 2' : null)

check('nothing running is no game', gameIn([]) === null)
check('a browser and the Steam client are no game', gameIn(run('C:\\Program Files\\Google\\Chrome\\chrome.exe', 'C:\\Program Files (x86)\\Steam\\steam.exe')) === null)
check(
  'a game in a Steam library on Windows',
  gameIn(run('D:\\SteamLibrary\\steamapps\\common\\Hades II\\Ship\\Hades2.exe')) === 'Hades II',
)
check(
  'Steam says the name when the folder is old',
  gameIn(run('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\csgo.exe'), steam) ===
    'Counter-Strike 2',
)
check(
  'a game in a Steam library on macOS',
  gameIn(run('/Users/a/Library/Application Support/Steam/steamapps/common/Balatro/Balatro.app/Contents/MacOS/love')) === 'Balatro',
)
check(
  'a Proton game on Linux',
  gameIn([{ exe: '/usr/bin/wine64-preloader', line: 'Z:\\home\\a\\.local\\share\\Steam\\steamapps\\common\\ELDEN RING\\Game\\start.exe' }]) === 'ELDEN RING',
)
check(
  'a shell that names a game folder is no game',
  gameIn([{ exe: '/bin/zsh', line: 'zsh -c ls ~/Library/Application Support/Steam/steamapps/common/Balatro/' }]) === null,
)
check('Proton itself is no game', gameIn(run('/home/a/.steam/steam/steamapps/common/Proton 9.0 (Beta)/files/bin/wineserver')) === null)
check('Wallpaper Engine is no game', gameIn(run('C:\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe')) === null)
check('the Epic launcher is no game', gameIn(run('C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe')) === null)
check('the Riot client is no game', gameIn(run('C:\\Riot Games\\Riot Client\\RiotClientServices.exe')) === null)
check('a known program by name', gameIn(run('C:\\Program Files (x86)\\Overwatch\\_retail_\\Overwatch.exe')) === 'Overwatch 2')
check('Roblox on macOS', gameIn(run('/Applications/Roblox.app/Contents/MacOS/RobloxPlayer')) === 'Roblox')
check(
  'Minecraft is java with minecraft in the command line',
  gameIn([{ exe: 'C:\\x\\runtime\\bin\\javaw.exe', line: 'javaw.exe -cp net.minecraft.client.main.Main' }]) === 'Minecraft',
)
check('plain java is no game', gameIn([{ exe: '/usr/bin/java', line: 'java -jar build-server.jar' }]) === null)
const both = run('C:\\Steam\\steamapps\\common\\Terraria\\Terraria.exe', 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe')
check('two games: the one already shown stays', gameIn(both, undefined, 'VALORANT') === 'VALORANT')
check('two games: the first when none is shown', gameIn(both) === 'Terraria')

finish()
