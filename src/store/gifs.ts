export interface Gif {
  url: string
  preview: string
}

export function isClip(url: string): boolean {
  return /\.(webm|mp4|m4v)(\?|$)/i.test(url)
}

// Security: remove a GIF API key that old versions stored in the browser.
try {
  localStorage.removeItem('nook.gifkey.v1')
} catch {}
