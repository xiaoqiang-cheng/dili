import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { interfaceScale } from './zoom';

/** Place transient composer controls outside the resizable input's scroll container. */
export default function AgentChatPopover({ anchor, children, close, className, label, id, role = 'group' }: {
  anchor: RefObject<HTMLElement | null>; children: ReactNode; close(): void; className: string;
  label: string; id?: string; role?: 'group' | 'listbox';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const reposition = useRef<() => void>(() => {});
  const [position, setPosition] = useState({ left: 0, top: 0, maxWidth: 320, maxHeight: 300 });
  const closeRef = useRef(close); closeRef.current = close;
  useLayoutEffect(() => {
    function positionPanel() {
      if (!anchor.current || !panel.current) return;
      const scale = interfaceScale(), rect = anchor.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) / scale + 8;
      const topEdge = (viewport?.offsetTop ?? 0) / scale + 8;
      const rightEdge = ((viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth)) / scale - 8;
      const bottomEdge = ((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)) / scale - 8;
      const maxWidth = Math.max(0, Math.min(360, rightEdge - leftEdge));
      const maxHeight = Math.max(0, Math.min(320, bottomEdge - topEdge));
      const width = Math.min(panel.current.offsetWidth, maxWidth), height = Math.min(panel.current.offsetHeight, maxHeight);
      const left = Math.max(leftEdge, Math.min(rect.left / scale, rightEdge - width));
      const above = rect.top / scale - 7 - height;
      const top = Math.max(topEdge, Math.min(above >= topEdge ? above : rect.bottom / scale + 7, bottomEdge - height));
      setPosition(previous => previous.left === left && previous.top === top && previous.maxWidth === maxWidth && previous.maxHeight === maxHeight ? previous : { left, top, maxWidth, maxHeight });
    }
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) closeRef.current();
    };
    reposition.current = positionPanel;
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    if (panel.current) observer.observe(panel.current);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    window.visualViewport?.addEventListener('resize', positionPanel);
    window.visualViewport?.addEventListener('scroll', positionPanel);
    document.addEventListener('pointerdown', outside);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', positionPanel); window.removeEventListener('scroll', positionPanel, true);
      window.visualViewport?.removeEventListener('resize', positionPanel); window.visualViewport?.removeEventListener('scroll', positionPanel);
      document.removeEventListener('pointerdown', outside);
    };
  }, [anchor]);
  // Native options arrive asynchronously. Keep their first painted layout in
  // bounds instead of waiting one frame for ResizeObserver after they expand.
  useLayoutEffect(() => { reposition.current(); });
  return createPortal(<div ref={panel} id={id} role={role} aria-label={label} className={className} style={position} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation(); closeRef.current(); anchor.current?.focus({ preventScroll: true });
    }
  }}>{children}</div>, document.body);
}
