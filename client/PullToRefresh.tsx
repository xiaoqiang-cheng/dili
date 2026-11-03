import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { t } from '../shared/i18n';
import { PULL_THRESHOLD, pullDistance, startsPull } from './pull-refresh';

const SPINNER_MIN_MS = 500;
// These keep their own touch gestures.
const INTERACTIVE = 'input, textarea, select, [role="menu"], .dropdown-menu';

/** Touch-only pull-down indicator for its parent scroller, like a chat app's contact
 * list. It owns the drag state, so following a finger never re-renders the page. */
export default function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const root = useRef<HTMLDivElement>(null);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const run = useRef(onRefresh);
  run.current = onRefresh;
  const busy = useRef(false);

  useEffect(() => {
    const scroller = root.current?.parentElement;
    if (!scroller) return;
    // On phones the surrounding workspace can be the element that actually scrolls.
    const atTop = () => {
      for (let element: HTMLElement | null = scroller; element; element = element.parentElement) if (element.scrollTop > 0) return false;
      return true;
    };
    let start: { x: number; y: number } | null = null, current = 0, pulling = false;
    const end = () => {
      const release = pulling && current >= PULL_THRESHOLD;
      start = null; pulling = false; current = 0;
      setDistance(0);
      if (!release || busy.current) return;
      busy.current = true; setRefreshing(true);
      const shown = new Promise(resolve => setTimeout(resolve, SPINNER_MIN_MS));
      // A failed refresh is reported by the page's own connection banner.
      void Promise.allSettled([run.current(), shown]).then(() => { busy.current = false; setRefreshing(false); });
    };
    const touchStart = (event: TouchEvent) => {
      const interactive = event.target instanceof Element && event.target.closest(INTERACTIVE);
      start = event.touches.length === 1 && !interactive && !busy.current ? { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY } : null;
      pulling = false; current = 0;
    };
    const touchMove = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) { start = null; pulling = false; current = 0; setDistance(0); return; }
      const deltaX = event.touches[0]!.clientX - start.x, deltaY = event.touches[0]!.clientY - start.y;
      if (!pulling) {
        if (Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4) return;
        if (!startsPull(atTop(), deltaX, deltaY)) { start = null; return; }
        pulling = true;
        // Measure from here so the indicator does not jump by the dead zone.
        start = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY };
      }
      if (event.cancelable) event.preventDefault();
      current = pullDistance(event.touches[0]!.clientY - start.y);
      setDistance(current);
    };
    // touchmove must not be passive, or preventDefault cannot stop the page's own overscroll.
    scroller.addEventListener('touchstart', touchStart, { passive: true });
    scroller.addEventListener('touchmove', touchMove, { passive: false });
    scroller.addEventListener('touchend', end);
    scroller.addEventListener('touchcancel', end);
    return () => {
      scroller.removeEventListener('touchstart', touchStart);
      scroller.removeEventListener('touchmove', touchMove);
      scroller.removeEventListener('touchend', end);
      scroller.removeEventListener('touchcancel', end);
    };
  }, []);

  const height = refreshing ? PULL_THRESHOLD * 0.8 : distance;
  const label = refreshing ? t('contacts.refreshing') : distance >= PULL_THRESHOLD ? t('contacts.releaseToRefresh') : t('contacts.pullToRefresh');
  return <div ref={root} className={`pull-refresh${distance ? ' pulling' : ''}`} style={{ height }} role={refreshing ? 'status' : undefined} aria-hidden={refreshing ? undefined : true}>
    {(refreshing || distance > 0) && <><LoaderCircle size={18} className={refreshing ? 'spin' : undefined} style={refreshing ? undefined : { transform: `rotate(${distance * 5}deg)` }} /><span>{label}</span></>}
  </div>;
}
