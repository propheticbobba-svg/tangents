import { createContext, useContext } from "react";

/**
 * What a formula box needs from the composer. One mic at a time: `micOwner` is
 * the id of the formula recording a voice edit, and `mainMicBusy` is the
 * composer's own dictation.
 */
export type FormulaEnv = {
  disabled: boolean;
  mainMicBusy: boolean;
  micOwner: string | null;
  setMicOwner: (update: (current: string | null) => string | null) => void;
  onError: (message: string) => void;
};

export const FormulaContext = createContext<FormulaEnv>({
  disabled: false,
  mainMicBusy: false,
  micOwner: null,
  setMicOwner: () => {},
  onError: () => {},
});

export function useFormulaEnv(): FormulaEnv {
  return useContext(FormulaContext);
}
