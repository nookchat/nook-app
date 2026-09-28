export interface Gif {
  url: string
  preview: string
  /** 0 when the service did not say. */
  width: number
  height: number
}

/** The link that goes in the message: the size rides after a #, so the chat can hold its place before it loads. */
export function gifLink(g: Gif): string {
  return g.width > 0 && g.height > 0 ? `${g.url}#${g.width}x${g.height}` : g.url
}

export function isClip(url: string): boolean {
  return /\.(webm|mp4|m4v)(\?|$)/i.test(url)
}

// Security: remove a GIF API key that old versions stored in the browser.
try {
  localStorage.removeItem('nook.gifkey.v1')
} catch {}
