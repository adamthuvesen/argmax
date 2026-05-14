import { createContext, useContext } from "react";

export const NowContext = createContext<number>(0);

export function useLiveNow(): number {
  return useContext(NowContext);
}
