import type { ReactNode } from "react";

export interface MobileHeaderContainerProps {
  children: ReactNode;
  /** Optional extra padding-top when mobile (e.g. for profile collapse progress) */
  paddingTop?: string;
  className?: string;
}

/**
 * Unified sticky container for mobile header content.
 * Used on both HomePage (tags + calendar) and ProfilePage (profile header + calendar).
 */
export function MobileHeaderContainer({ children, paddingTop, className = "" }: MobileHeaderContainerProps) {
  return (
    <div
      className={`mobile-header-container ${className}`.trim()}
      style={paddingTop ? { paddingTop } : undefined}
    >
      {children}
    </div>
  );
}
