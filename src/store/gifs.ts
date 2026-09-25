/**
 * Finding a GIF.
 *
 * The server of the space searches, with its own key, and the browser asks
 * it. The key is in the server's environment and nowhere else: not in the
 * page, not on anybody's device, and not in a setting a member can change.
 * Whoever runs the server turns search on for everybody on it. See
 * server/src/gifs.mjs.
 */

export interface Gif {
  /** The animation itself, which is what gets said. */
  url: string
  /** A smaller copy for the grid, so a search is not twenty full GIFs. */
  preview: string
}

/** Whether this is a clip to be played rather than a picture to be drawn. */
export function isClip(url: string): boolean {
  return /\.(webm|mp4|m4v)(\?|$)/i.test(url)
}

/*
 * A key a person once kept in this browser, from before the server held it.
 * It is no use now, and a key left lying about is a key somebody finds.
 */
try {
  localStorage.removeItem('cathode.gifkey.v1')
} catch {
  // Storage that cannot be read holds no key either.
}
