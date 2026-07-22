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
// Steam configuration
// ---------------------------------------------------------------------------

/// Read the registered AppID from the build environment. Valve's public Spacewar
/// test ID (480) is rejected so it can never reach a release by accident.
#[cfg(any(feature = "steam", test))]
fn parse_steam_app_id(value: Option<&str>) -> Option<u32> {
    value
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|id| *id > 0 && *id != 480)
}

#[cfg(feature = "steam")]
fn configured_steam_app_id() -> Option<u32> {
    parse_steam_app_id(option_env!("BELFAST_STEAM_APP_ID"))
}

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
    #[cfg(feature = "steam")]
    app_id: Option<u32>,
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

/// Client-owned JavaScript scores are not a trustable leaderboard input. Keep
/// the command for frontend compatibility, but fail closed until a trusted
/// service verifies runs and submits through Steam's Web API.
#[tauri::command]
fn update_leaderboard(_state: tauri::State<'_, SteamState>, _score: i32) -> SteamResponse {
    leaderboard_disabled_response()
}

fn leaderboard_disabled_response() -> SteamResponse {
    SteamResponse {
        ok: false,
        message: "Leaderboard disabled until runs are validated by a trusted service".into(),
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
                message: format!("Steam running (AppID {})", state.app_id.unwrap_or_default()),
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
                if let Some(app_id) = configured_steam_app_id() {
                    match steamworks::Client::init_app(app_id) {
                        Ok(client) => {
                            eprintln!(
                                "[steam] Initialised successfully (AppID {})",
                                app_id
                            );

                            // Manage state first — commands can now access the client.
                            app.manage(SteamState {
                                client: std::sync::Mutex::new(Some(client.clone())),
                                app_id: Some(app_id),
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
                                app_id: Some(app_id),
                            });
                        }
                    }
                } else {
                    eprintln!(
                        "[steam] Disabled: set BELFAST_STEAM_APP_ID to the registered AppID (480 is rejected)"
                    );
                    app.manage(SteamState {
                        client: std::sync::Mutex::new(None),
                        app_id: None,
                    });
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

#[cfg(test)]
mod tests {
    use super::{leaderboard_disabled_response, parse_steam_app_id};

    #[test]
    fn steam_app_id_must_be_registered_and_non_test() {
        assert_eq!(parse_steam_app_id(None), None);
        assert_eq!(parse_steam_app_id(Some("")), None);
        assert_eq!(parse_steam_app_id(Some("480")), None);
        assert_eq!(parse_steam_app_id(Some("not-a-number")), None);
        assert_eq!(parse_steam_app_id(Some("1234567")), Some(1_234_567));
    }

    #[test]
    fn client_leaderboard_uploads_fail_closed() {
        let response = leaderboard_disabled_response();
        assert!(!response.ok);
        assert!(response.message.contains("trusted service"));
    }
}
