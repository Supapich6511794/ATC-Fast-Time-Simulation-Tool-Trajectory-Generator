"use client";

/**
 * MainNavItem — one tab on the global bar.
 *
 * Presentation only: it owns no state and decides nothing. Whether it looks
 * active, whether its dropdown is open and what that dropdown contains are all
 * the bar's business, so the same component renders an action tab (Home,
 * Export) and a menu tab (Tool, Conflicts) without branching on which is which.
 */

import { memo, type ReactNode } from "react";

export interface MainNavItemProps {
  /** Stable id — used for the aria wiring between tab and dropdown. */
  id: string;
  icon: ReactNode;
  label: string;
  /** Hide the label and show the glyph alone. The Home tab opts in here; the
   *  same thing happens to every tab on a narrow screen, which is CSS. */
  iconOnly?: boolean;
  hint?: string;
  /** The page/menu this tab leads to is the one currently showing. */
  active?: boolean;
  disabled?: boolean;
  /** Renders the caret and the aria-haspopup wiring. */
  hasMenu?: boolean;
  open?: boolean;
  /** A count beside the label: "accent" for information (how many routes),
   *  "alert" for something unresolved (how many conflicts). */
  badge?: { text: string; tone?: "accent" | "alert" } | null;
  onSelect: () => void;
  /** Dropdown contents. Only rendered while `open`. */
  children?: ReactNode;
}

function MainNavItem({
  id,
  icon,
  label,
  iconOnly,
  hint,
  active,
  disabled,
  hasMenu,
  open,
  badge,
  onSelect,
  children,
}: MainNavItemProps) {
  return (
    <div className={`mnav-slot${open ? " open" : ""}`}>
      <button
        type="button"
        id={`mnav-tab-${id}`}
        className={`mnav-item${iconOnly ? " icon-only" : ""}${
          active ? " active" : ""
        }${open ? " open" : ""}`}
        onClick={onSelect}
        disabled={disabled}
        title={hint}
        aria-label={iconOnly ? label : undefined}
        aria-haspopup={hasMenu ? "menu" : undefined}
        aria-expanded={hasMenu ? !!open : undefined}
        aria-pressed={hasMenu ? undefined : !!active}
      >
        <span className="mnav-ico" aria-hidden>
          {icon}
        </span>
        {!iconOnly && <span className="mnav-label">{label}</span>}
        {badge && (
          <span className={`mnav-badge${badge.tone === "alert" ? " alert" : ""}`}>
            {badge.text}
          </span>
        )}
        {hasMenu && (
          <span className="mnav-caret" aria-hidden>
            ▾
          </span>
        )}
      </button>

      {hasMenu && open && children && (
        <div
          className="mnav-pop"
          role="menu"
          aria-labelledby={`mnav-tab-${id}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default memo(MainNavItem);
