import { invoke } from "@tauri-apps/api/core";

/**
 * Steam
 * -----
 * Frontend abstraction over the Rust Tauri commands. When running in a plain
 * browser (`npm run dev` without Tauri) or when Steam isn't available, every
 * call degrades to a logged no-op so gameplay is never blocked.
 *
 *   import { Steam } from "./utils/steam.js";
 *   await Steam.unlock("ACH_FIRST_KICK");
 *   await Steam.submitScore(12345);
 */
const inTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

class SteamBridge {
  constructor() {
    this.available = inTauri;
    this._unlocked = new Set();
  }

  async _invoke(cmd, args) {
    if (!this.available) {
      console.info(`[Steam:stub] ${cmd}`, args || "");
      return { ok: false, stub: true };
    }
    try {
      return await invoke(cmd, args);
    } catch (err) {
      console.warn(`[Steam] ${cmd} failed:`, err);
      return { ok: false, error: String(err) };
    }
  }

  /** Unlock an achievement once per session (dedup avoids spamming Steam). */
  async unlock(achievementId) {
    if (this._unlocked.has(achievementId)) return { ok: true, cached: true };
    this._unlocked.add(achievementId);
    return this._invoke("unlock_achievement", { achievementId });
  }

  /** Post a high score / combo score to the Steam leaderboard. */
  async submitScore(score) {
    return this._invoke("update_leaderboard", { score: Math.round(score) });
  }

  /** Optional: ask the backend whether the Steam client initialised. */
  async status() {
    return this._invoke("steam_status");
  }
}

export const Steam = new SteamBridge();
