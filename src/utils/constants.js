/** Public asset root (Vite's configured base, "/" in dev). */
export const BASE = import.meta.env.BASE_URL || "/";

/**
 * Mouse-sensitivity slider bounds (radians per mouse-pixel) and graphics-quality
 * options, shared by the safehouse Menu and the in-operation PauseMenu so both
 * panels edit `progression.settings` identically (CONTRACTS.md §3).
 */
export const SENS_MIN = 0.0008;
export const SENS_MAX = 0.005;
export const SENS_STEP = 0.0002;

export const QUALITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Default settings — used as the floor in GameState and whenever a persisted block is missing. */
export const DEFAULT_SETTINGS = { sensitivity: 0.0022, quality: "high", muted: false };
