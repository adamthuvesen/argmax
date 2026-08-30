import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
  type Placement,
  type VirtualElement
} from "@floating-ui/react-dom";
import { useCallback, useMemo, useRef, type CSSProperties, type RefObject } from "react";

/**
 * Anchored positioning for every portaled popover: menus, pickers, and
 * right-click context menus.
 *
 * Each of these used to clamp itself against the viewport by hand, with a
 * different (and in two cases incomplete) idea of what "stay on screen" meant —
 * one measured its own height, one guessed it from an item count, one skipped
 * the vertical axis entirely, and the model flyout had no viewport awareness at
 * all. Floating UI positions all of them the same way: flip to the opposite
 * side when the preferred one won't fit, then shift along the cross axis to
 * stay inside the viewport.
 *
 * Positioning is `fixed` and recomputed on scroll/resize, so a popover portaled
 * to `<body>` tracks an anchor that moves underneath it.
 */

/** A point in viewport coordinates — where a right-click landed. */
export interface AnchorPoint {
  x: number;
  y: number;
}

export interface AnchoredPopoverOptions {
  /** Whether the popover is on screen. Positioning only runs while it is. */
  open: boolean;
  /** Preferred side. `flip` takes the opposite one when this won't fit. */
  placement?: Placement;
  /** Gap between the anchor and the popover. */
  gutter?: number;
  /** Smallest gap kept between the popover and the viewport edge. */
  edgePadding?: number;
  /**
   * Cap `max-height` to the room actually left on the chosen side. Without it a
   * long list keeps its stylesheet height and runs off the bottom of the
   * screen once neither side can hold it whole.
   */
  capHeight?: boolean;
  /**
   * `fixed` for popovers portaled to `<body>`. `absolute` for one that stays
   * inside its anchor's subtree, so it keeps inheriting the surrounding
   * stacking context and descendant CSS.
   */
  strategy?: "absolute" | "fixed";
}

export interface AnchoredPopover {
  /** Attach to the element the popover hangs off. */
  setAnchor: (node: HTMLElement | null) => void;
  /** Attach to the popover itself. */
  setPopover: (node: HTMLElement | null) => void;
  /** The anchor element, for `useDismissOnOutsideOrEscape`. */
  anchorRef: RefObject<HTMLElement | null>;
  /** The popover element, for `useDismissOnOutsideOrEscape`. */
  popoverRef: RefObject<HTMLElement | null>;
  /** Spread onto the popover's `style`. */
  floatingStyles: CSSProperties;
  /** The side actually chosen, after flipping. */
  placement: Placement;
  /**
   * Anchor to a viewport point instead of an element — a right-click position.
   * Pass `null` to detach.
   */
  anchorToPoint: (point: AnchorPoint | null) => void;
}

/** A capped popover never shrinks below this; below it, scrolling is useless. */
const MIN_CAPPED_HEIGHT = 120;

/** A zero-size virtual element at the cursor, for right-click menus. */
function pointReference({ x, y }: AnchorPoint): VirtualElement {
  return {
    getBoundingClientRect: () => ({
      width: 0,
      height: 0,
      x,
      y,
      top: y,
      left: x,
      right: x,
      bottom: y
    })
  };
}

export function useAnchoredPopover({
  open,
  placement = "bottom-start",
  gutter = 6,
  edgePadding = 8,
  capHeight = false,
  strategy = "fixed"
}: AnchoredPopoverOptions): AnchoredPopover {
  const middleware = useMemo(
    () => [
      offset(gutter),
      flip({ padding: edgePadding }),
      shift({ padding: edgePadding }),
      ...(capHeight
        ? [
            size({
              padding: edgePadding,
              apply({ availableHeight, elements }) {
                elements.floating.style.maxHeight = `${Math.max(
                  MIN_CAPPED_HEIGHT,
                  Math.round(availableHeight)
                )}px`;
              }
            })
          ]
        : [])
    ],
    [gutter, edgePadding, capHeight]
  );

  const {
    refs,
    floatingStyles: anchoredStyles,
    placement: resolvedPlacement
  } = useFloating({
    open,
    placement,
    strategy,
    middleware,
    whileElementsMounted: autoUpdate
  });

  // Floating UI's own reference ref holds a virtual element for point anchors,
  // so it can't stand in for the DOM node the dismiss hook needs to hit-test.
  const anchorRef = useRef<HTMLElement | null>(null);
  const setAnchor = useCallback(
    (node: HTMLElement | null): void => {
      anchorRef.current = node;
      refs.setReference(node);
    },
    [refs]
  );

  const anchorToPoint = useCallback(
    (point: AnchorPoint | null): void => {
      refs.setReference(point ? pointReference(point) : null);
    },
    [refs]
  );

  // Floating UI positions from `top`/`left` only. The popover stylesheets still
  // carry the sides they used before this hook existed — `.project-picker-popover`
  // opens upward with `bottom: calc(100% + 6px)` — and a box with both edges set
  // is over-constrained: the browser derives its height from the containing
  // block and collapses it to the padding. Clearing the far edges keeps the
  // element sized by its content wherever it is placed.
  const floatingStyles = useMemo(
    () => ({ ...anchoredStyles, right: "auto", bottom: "auto" }),
    [anchoredStyles]
  );

  return {
    setAnchor,
    setPopover: refs.setFloating,
    anchorRef,
    popoverRef: refs.floating,
    floatingStyles,
    placement: resolvedPlacement,
    anchorToPoint
  };
}
