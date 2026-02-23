import { useEffect, useState } from "react";

const DEFAULT_BREAKPOINT = 640;

/**
 * Returns true when viewport width is at or below the breakpoint (default 640px).
 * Matches Tailwind's `sm` breakpoint for consistent responsive behavior.
 */
export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);

  return isMobile;
}
