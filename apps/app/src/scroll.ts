// Scrolling by voice. Niko scrolls whatever is the main scrolling area on screen right now: the largest visible
// part of the page that can still move that way (a conversation, a list, a settings page), or the page itself.
type Way = 'down' | 'up' | 'top' | 'bottom';

function canMove(el: Element, way: Way): boolean {
  const down = way === 'down' || way === 'bottom';
  return down ? el.scrollTop + el.clientHeight < el.scrollHeight - 2 : el.scrollTop > 1;
}

function visibleArea(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return w > 120 && h > 80 ? w * h : 0;
}

/** Scrolls the main scrolling area. Returns false when nothing on screen can move that way. */
export function scrollScreen(way: Way): boolean {
  const candidates: HTMLElement[] = [];
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'CANVAS' || el.closest('dialog:not([open])')) continue;
    if (el.scrollHeight <= el.clientHeight + 2) continue;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && canMove(el, way) && visibleArea(el)) candidates.push(el);
  }
  const page = document.scrollingElement as HTMLElement | null;
  if (page && page.scrollHeight > innerHeight + 2 && canMove(page, way)) candidates.push(page);
  if (!candidates.length) return false;
  // The biggest area on screen is the one being read; where the keyboard focus is wins a tie.
  const focus = document.activeElement;
  const target = candidates.sort((a, b) => (visibleArea(b) || innerWidth * innerHeight) - (visibleArea(a) || innerWidth * innerHeight) || Number(b.contains(focus)) - Number(a.contains(focus)))[0]!;
  const behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const step = Math.max(160, Math.round(target.clientHeight * 0.8));
  if (way === 'top') target.scrollTo({ top: 0, behavior });
  else if (way === 'bottom') target.scrollTo({ top: target.scrollHeight, behavior });
  else target.scrollBy({ top: way === 'down' ? step : -step, behavior });
  return true;
}
