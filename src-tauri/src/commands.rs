use crate::diff_engine::DiffEngine;
use crate::git_history::GitHistoryManager;
use crate::models::{CompareSession, DiffOptions, FileDiffDetail, SyncFolderEntry, SyncHistory};
use crate::AppState;
use rfd::FileDialog;
use std::sync::atomic::Ordering;
use tauri::AppHandle;

#[tauri::command]
pub fn select_directory() -> Result<Option<String>, String> {
    let res = FileDialog::new().pick_folder();
    Ok(res.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn select_file() -> Result<Option<String>, String> {
    let res = FileDialog::new().pick_file();
    Ok(res.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn compare_directories(
    left: String,
    right: String,
    options: DiffOptions,
    state: tauri::State<'_, AppState>,
) -> Result<CompareSession, String> {
    state.is_cancelled.store(false, Ordering::Relaxed);
    let is_cancelled = state.is_cancelled.clone();

    tauri::async_runtime::spawn_blocking(move || {
        DiffEngine::compare_directories(&left, &right, options, is_cancelled)
    })
    .await
    .map_err(|e| format!("Async task execution error: {}", e))?
}

#[tauri::command]
pub async fn cancel_compare(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.is_cancelled.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn compare_files(
    left: String,
    right: String,
    options: DiffOptions,
) -> Result<FileDiffDetail, String> {
    DiffEngine::compare_files(&left, &right, options)
}

#[tauri::command]
pub fn sync_file(
    app: AppHandle,
    session_id: String,
    mode: String,
    sync_type: String,
    direction: String,
    source_path: String,
    target_path: String,
    before_hash: String,
) -> Result<SyncHistory, String> {
    let manager = GitHistoryManager::new(&app);
    manager.initialize()?;
    manager.save_sync_snapshot(
        &session_id,
        &mode,
        &sync_type,
        &direction,
        &source_path,
        &target_path,
        &before_hash,
    )
}

#[tauri::command]
pub fn sync_folder(
    app: AppHandle,
    session_id: String,
    mode: String,
    direction: String,
    source_path: String,
    target_path: String,
    entries: Vec<SyncFolderEntry>,
) -> Result<SyncHistory, String> {
    let manager = GitHistoryManager::new(&app);
    manager.initialize()?;
    manager.save_folder_sync_snapshot(
        &session_id,
        &mode,
        &direction,
        &source_path,
        &target_path,
        &entries,
    )
}

#[tauri::command]
pub fn get_sync_histories(app: AppHandle) -> Result<Vec<SyncHistory>, String> {
    let manager = GitHistoryManager::new(&app);
    manager.initialize()?;
    manager.get_histories()
}

#[tauri::command]
pub fn restore_sync(app: AppHandle, history_id: String) -> Result<SyncHistory, String> {
    let manager = GitHistoryManager::new(&app);
    manager.initialize()?;
    manager.restore_sync(&history_id)
}
