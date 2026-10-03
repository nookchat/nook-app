/**
 * Plays a looping clip, such as a GIF, only while it is on screen or near it. A playing clip
 * holds a decoder and its frames in memory, and a long chat or the GIF picker can have dozens.
 */
const near =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const video = entry.target as HTMLVideoElement
            if (entry.isIntersecting) void video.play().catch(() => undefined)
            else video.pause()
          }
        },
        // scrollMargin reaches into the chat's own scroll box, which rootMargin does not.
        { rootMargin: '300px 0px', scrollMargin: '300px 0px' } as IntersectionObserverInit,
      )

export function playWhileSeen(video: HTMLVideoElement): void {
  if (near) near.observe(video)
  else {
    video.autoplay = true
    void video.play().catch(() => undefined)
  }
}
