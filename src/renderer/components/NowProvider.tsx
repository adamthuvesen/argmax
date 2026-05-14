import type { JSX, ReactNode } from "react";
import { NowContext } from "../hooks/nowContext.js";
import { useNow } from "../hooks/useNow.js";

export function NowProvider({
  active,
  intervalMs = 100,
  children
}: {
  active: boolean;
  intervalMs?: number;
  children: ReactNode;
}): JSX.Element {
  const now = useNow(active, intervalMs);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}
