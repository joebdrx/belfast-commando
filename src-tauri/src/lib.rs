// Belfast Commando — Tauri backend
//
// Steamworks integration is FEATURE-GATED:
//   • Default build (`cargo build`)               — zero Steam SDK requirement
//   • Steam build   (`cargo build --features steam`) — real Steamworks calls
//
// All three commands keep IDENTICAL signatures regardless of the active feature
// so the JS layer never needs to change.

use tauri::Manager;

// ---------------------------------------------------------------------------
// Constants — change STEAM_APP_ID to your real Steam AppID before shipping.
// ---------------------------------------------------------------------------

/// Spacewar (480) is a public test app available on most Steam installs.
/// Replace with your game's AppID once registered in the Steamworks portal.
/// Only referenced under the `steam` feature, so gate it to keep the default
/// build warning-clean.
#[cfg(feature = "steam")]
const STEAM_APP_ID: u32 = 480;

/// Name of the Steam leaderboard to post scores to.
/// Must match the leaderboard you created in the Steamworks partner portal.
#[cfg(feature = "steam")]
const STEAM_LEADERBOARD_NAME: &str = "HighScores";

// ---------------------------------------------------------------------------
// Shared response type
// ---------------------------------------------------------------------------

/// Every Steam command returns this so the frontend always has a consistent shape.
#[derive(serde::Serialize)]
struct SteamResponse {
    ok: bool,
    message: String,
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// Tauri managed state for the Steam client.
///
/// * Feature OFF → empty struct; compiles with no Steam dependency.
/// * Feature ON  → holds an initialised client wrapped in `Mutex<Option<…>>`.
///   `None` means Steam was not running when the app launched (dev/CI scenario).
pub struct SteamState {
    #[cfg(feature = "steam")]
    client: std::sync::Mutex<Option<steamworks::Client>>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Unlock a Steam achievement by its API name (e.g. "ACH_FIRST_KICK").
///
/// Stub behaviour (steam feature OFF):
///   Returns ok:false with a message explaining the build flag.
#[tauri::command]
fn unlock_achievement(
    state: tauri::State<'_, SteamState>,
    achievement_id: String,
) -> SteamResponse {
    #[cfg(feature = "steam")]
    {
        let guard = state.client.lock().unwrap();
        match guard.as_ref() {
            None => SteamResponse {
                ok: false,
                message: "Steam not running".into(),
            },
            Some(client) => {
                let us = client.user_stats();
                match us.achievement(&achievement_id).set() {
                    Ok(_) => match us.store_stats() {
                        Ok(_) => SteamResponse {
                            ok: true,
                            message: format!("Achievement {} unlocked", achievement_id),
                        },
                        Err(_) => SteamResponse {
                            ok: false,
                            message: format!(
                                "Achievement {} set but store_stats failed",
                                achievement_id
                            ),
                        },
                    },
                    Err(_) => SteamResponse {
                        ok: false,
                        message: format!(
                            "Failed to set achievement {} (stats not yet loaded?)",
                            achievement_id
                        ),
                    },
                }
            }
        }
    }

    // Graceful stub when compiled without the steam feature.
    #[cfg(not(feature = "steam"))]
    {
        let _ = state; // suppress unused-variable warning
        SteamResponse {
            ok: false,
            message: format!(
                "Steam disabled (build with --features steam): would unlock {achievement_id}"
            ),
        }
    }
}

/// Post a score to the game's Steam leaderboard.
///
/// The leaderboard lookup + upload are callback-driven (async in Steamworks
/// terms).  A background thread pumps `run_callbacks()` so the callbacks fire
/// without blocking this command; the command returns immediately with
/// ok:true / "queued" once the request is registered.
///
/// Stub behaviour (steam feature OFF):
///   Returns ok:false with a message explaining the build flag.
#[tauri::command]
fn update_leaderboard(
    state: tauri::State<'_, SteamState>,
    score: i32,
) -> SteamResponse {
    #[cfg(feature = "steam")]
    {
        let guard = state.client.lock().unwrap();
        match guard.as_ref() {
            None => SteamResponse {
                ok: false,
                message: "Steam not running".into(),
            },
            Some(client) => {
                // `UserStats` wraps a raw pointer and is !Send, so it cannot be
                // captured by the 'static + Send closure that find_leaderboard
                // requires.  Instead we clone the Client (which IS Send+Sync —
                // it is Arc-based and has static_assert_send/sync checks in the
                // steamworks crate) and call user_stats() *inside* the callback,
                // which executes on the background run_callbacks thread.
                let client_for_closure = client.clone();
                let us = client.user_stats();

                us.find_leaderboard(STEAM_LEADERBOARD_NAME, move |result| {
                    match result {
                        Ok(Some(lb)) => {
                            // Obtain a fresh UserStats on this (background) thread.
                            let us2 = client_for_closure.user_stats();
                            us2.upload_leaderboard_score(
                                &lb,
                                steamworks::UploadScoreMethod::KeepBest,
                                score,
                                &[],
                                |r| {
                                    if let Err(e) = r {
                                        eprintln!("[steam] leaderboard upload error: {e:?}");
                                    }
                                },
                            );
                        }
                        Ok(None) => {
                            eprintln!(
                                "[steam] leaderboard '{}' not found",
                                STEAM_LEADERBOARD_NAME
                            );
                        }
                        Err(e) => {
                            eprintln!("[steam] find_leaderboard error: {e:?}");
                        }
                    }
                });

                SteamResponse {
                    ok: true,
                    message: format!("Score {score} queued for leaderboard upload"),
                }
            }
        }
    }

    // Graceful stub when compiled without the steam feature.
    #[cfg(not(feature = "steam"))]
    {
        let _ = state; // suppress unused-variable warning
        SteamResponse {
            ok: false,
            message: format!(
                "Steam disabled (build with --features steam): would post score {score}"
            ),
        }
    }
}

/// Returns whether the Steam client initialised successfully at app launch.
///
/// Stub behaviour (steam feature OFF):
///   Always returns ok:false — Steam is not linked into this build.
#[tauri::command]
fn steam_status(state: tauri::State<'_, SteamState>) -> SteamResponse {
    #[cfg(feature = "steam")]
    {
        let guard = state.client.lock().unwrap();
        match guard.as_ref() {
            None => SteamResponse {
                ok: false,
                message: "Steam not running".into(),
            },
            Some(_) => SteamResponse {
                ok: true,
                message: format!("Steam running (AppID {})", STEAM_APP_ID),
            },
        }
    }

    #[cfg(not(feature = "steam"))]
    {
        let _ = state; // suppress unused-variable warning
        SteamResponse {
            ok: false,
            message: "Steam disabled (build with --features steam)".into(),
        }
    }
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // --- Steam initialisation (feature-gated) ---
            //
            // Failure is NON-FATAL: Steam may not be running in dev/CI.
            // We log a warning and store None so commands degrade gracefully.

            #[cfg(feature = "steam")]
            {
                match steamworks::Client::init_app(STEAM_APP_ID) {
                    Ok(client) => {
                        eprintln!(
                            "[steam] Initialised successfully (AppID {})",
                            STEAM_APP_ID
                        );

                        // Manage state first — commands can now access the client.
                        app.manage(SteamState {
                            client: std::sync::Mutex::new(Some(client.clone())),
                        });

                        // Background thread: pump Steamworks callbacks at ~20 Hz.
                        // This is required for async APIs (leaderboard find/upload)
                        // to dispatch their result closures.
                        std::thread::spawn(move || loop {
                            client.run_callbacks();
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        });
                    }
                    Err(e) => {
                        // Steam not running or AppID not owned — expected in dev.
                        eprintln!(
                            "[steam] Init failed (Steam may not be running): {e:?}"
                        );
                        app.manage(SteamState {
                            client: std::sync::Mutex::new(None),
                        });
                    }
                }
            }

            // When the steam feature is disabled, manage an empty state struct
            // so the three commands can still resolve their tauri::State parameter.
            #[cfg(not(feature = "steam"))]
            {
                app.manage(SteamState {});
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            unlock_achievement,
            update_leaderboard,
            steam_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
