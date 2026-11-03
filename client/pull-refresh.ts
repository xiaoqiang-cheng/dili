/** Pixels the indicator must travel before letting go refreshes. */
export const PULL_THRESHOLD = 56;
const PULL_MAX = 88;
const PULL_RESISTANCE = 0.5;

/** How far the indicator follows a finger that has moved `delta` pixels down. */
export function pullDistance(delta: number): number {
  return Math.min(PULL_MAX, Math.max(0, delta) * PULL_RESISTANCE);
}

/** A pull begins only from the very top and only when the finger moves mostly
 * downward; anything else stays an ordinary scroll or a horizontal swipe. */
export function startsPull(atTop: boolean, deltaX: number, deltaY: number): boolean {
  return atTop && deltaY > 0 && deltaY > Math.abs(deltaX);
}
