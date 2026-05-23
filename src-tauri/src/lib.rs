mod models;
mod git_history;
mod diff_engine;
mod commands;

use git_history::GitHistoryManager;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub is_cancelled: Arc<AtomicBool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // アプリ起動時に履歴管理領域を初期化
            let manager = GitHistoryManager::new(app.handle());
            if let Err(e) = manager.initialize() {
                eprintln!("Failed to initialize GitHistoryManager: {}", e);
            }

            // AppStateを管理対象に追加
            app.manage(AppState {
                is_cancelled: Arc::new(AtomicBool::new(false)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::select_directory,
            commands::select_file,
            commands::compare_directories,
            commands::compare_files,
            commands::sync_file,
            commands::get_sync_histories,
            commands::restore_sync,
            commands::cancel_compare
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

