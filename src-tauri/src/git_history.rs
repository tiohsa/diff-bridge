use crate::models::SyncHistory;
use chrono::Utc;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub struct GitHistoryManager {
    git_dir: PathBuf,
}

impl GitHistoryManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        let local_dir = app_handle
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("history_git");
        
        Self { git_dir: local_dir }
    }

    /// Gitリポジトリとデータフォルダの初期化
    pub fn initialize(&self) -> Result<(), String> {
        if !self.git_dir.exists() {
            fs::create_dir_all(&self.git_dir).map_err(|e| e.to_string())?;
        }

        let snapshots_dir = self.git_dir.join("snapshots");
        if !snapshots_dir.exists() {
            fs::create_dir_all(&snapshots_dir).map_err(|e| e.to_string())?;
        }

        let history_json = self.git_dir.join("history.json");
        if !history_json.exists() {
            fs::write(&history_json, "[]").map_err(|e| e.to_string())?;
        }

        // git init の実行
        let is_git_repo = self.git_dir.join(".git").exists();
        if !is_git_repo {
            self.run_git(&["init"])?;
            self.run_git(&["config", "user.name", "diff-app"])?;
            self.run_git(&["config", "user.email", "diff-app@local"])?;
            
            // 初期コミットを作成
            self.run_git(&["add", "history.json"])?;
            self.run_git(&["commit", "-m", "Initial commit (diff-app history initialized)"])?;
        }

        Ok(())
    }

    /// Gitコマンドを実行する汎用ユーティリティ
    fn run_git(&self, args: &[&str]) -> Result<String, String> {
        let output = if cfg!(target_os = "windows") {
            Command::new("cmd")
                .args(&["/C", "git"])
                .args(args)
                .current_dir(&self.git_dir)
                .output()
        } else {
            Command::new("git")
                .args(args)
                .current_dir(&self.git_dir)
                .output()
        };

        match output {
            Ok(out) => {
                if out.status.success() {
                    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
                } else {
                    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    Err(format!("Git error: {}. Output: {}", err, String::from_utf8_lossy(&out.stdout).trim()))
                }
            }
            Err(e) => Err(format!("Failed to execute git process: {}", e)),
        }
    }

    /// 履歴リストを取得
    pub fn get_histories(&self) -> Result<Vec<SyncHistory>, String> {
        let history_json = self.git_dir.join("history.json");
        if !history_json.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&history_json).map_err(|e| e.to_string())?;
        let histories: Vec<SyncHistory> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(histories)
    }

    /// 履歴リストを保存
    fn save_histories(&self, histories: &[SyncHistory]) -> Result<(), String> {
        let history_json = self.git_dir.join("history.json");
        let content = serde_json::to_string_pretty(histories).map_err(|e| e.to_string())?;
        fs::write(&history_json, content).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// ファイルのハッシュ値（SHA-256）を計算
    pub fn calculate_hash(path: &Path) -> Result<String, String> {
        if !path.exists() {
            return Ok("".to_string());
        }

        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0; 8192];

        loop {
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }

        Ok(hex::encode(hasher.finalize()))
    }

    /// 同期のスナップショット保存と同期実行、Gitコミット
    pub fn save_sync_snapshot(
        &self,
        session_id: &str,
        mode: &str,
        sync_type: &str,
        direction: &str,
        source_path: &str,
        target_path: &str,
        expected_before_hash: &str,
    ) -> Result<SyncHistory, String> {
        let src_p = Path::new(source_path);
        let tgt_p = Path::new(target_path);

        // 外部変更検知（同期前に対象ファイルが外部変更されていないか検証）
        if tgt_p.exists() {
            let current_hash = Self::calculate_hash(tgt_p)?;
            // もし期待ハッシュ値が空でない、かつ現在のハッシュ値と一致しない場合はエラー
            if !expected_before_hash.is_empty() && current_hash != expected_before_hash {
                return Err("External change detected: The target file has been modified externally since last comparison. Please re-compare first.".to_string());
            }
        } else if !expected_before_hash.is_empty() {
            return Err("External change detected: The target file was expected to exist but is missing. Please re-compare first.".to_string());
        }

        // 同期レコードのID生成
        let sync_id = Uuid::new_v4().to_string();
        let snapshot_sync_dir = self.git_dir.join("snapshots").join(&sync_id);
        
        let before_dir = snapshot_sync_dir.join("before");
        let after_dir = snapshot_sync_dir.join("after");

        fs::create_dir_all(&before_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(&after_dir).map_err(|e| e.to_string())?;

        // 1. 同期前のターゲットファイルが存在する場合、スナップショット保存 (before)
        let file_name = tgt_p.file_name().unwrap_or_else(|| src_p.file_name().unwrap());
        let before_file_path = before_dir.join(file_name);
        let before_hash = if tgt_p.exists() {
            fs::copy(tgt_p, &before_file_path).map_err(|e| e.to_string())?;
            Self::calculate_hash(tgt_p)?
        } else {
            "".to_string()
        };

        // 2. 同期の実行 (ファイルの作成または上書き)
        // 同期先ディレクトリの存在確認と作成
        if let Some(parent) = tgt_p.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        
        // 元ファイルをコピーして同期を実行
        if src_p.exists() {
            fs::copy(src_p, tgt_p).map_err(|e| e.to_string())?;
        } else {
            return Err(format!("Source file does not exist: {}", source_path));
        }

        // 3. 同期後のターゲットファイルをスナップショット保存 (after)
        let after_file_path = after_dir.join(file_name);
        fs::copy(tgt_p, &after_file_path).map_err(|e| e.to_string())?;
        let after_hash = Self::calculate_hash(tgt_p)?;

        // 4. メタデータの作成
        let mut history = SyncHistory {
            id: sync_id.clone(),
            session_id: session_id.to_string(),
            mode: mode.to_string(),
            sync_type: sync_type.to_string(),
            direction: direction.to_string(),
            source_path: source_path.to_string(),
            target_path: target_path.to_string(),
            before_hash,
            after_hash,
            commit_id: "".to_string(), // 後で設定
            created_at: Utc::now(),
            status: "success".to_string(),
        };

        // 5. history.json に追加
        let mut histories = self.get_histories()?;
        histories.push(history.clone());
        self.save_histories(&histories)?;

        // 6. Gitコミット
        self.run_git(&["add", "."])?;
        
        let commit_msg = format!(
            "sync: apply diff\n\nMode: {}\nSync type: {}\nDirection: {}\nSource: {}\nTarget: {}\nTimestamp: {}",
            mode, sync_type, direction, source_path, target_path, Utc::now().to_rfc3339()
        );
        self.run_git(&["commit", "-m", &commit_msg])?;

        // 7. コミットハッシュの取得
        let commit_hash = self.run_git(&["rev-parse", "HEAD"])?;
        history.commit_id = commit_hash.clone();

        // メタデータのコミットハッシュを更新して再保存
        let mut histories = self.get_histories()?;
        if let Some(h) = histories.iter_mut().find(|x| x.id == sync_id) {
            h.commit_id = commit_hash.clone();
        }
        self.save_histories(&histories)?;

        // アメンドコミットで history.json のハッシュ情報もコミットに統合
        self.run_git(&["add", "history.json"])?;
        self.run_git(&["commit", "--amend", "--no-edit"])?;

        Ok(history)
    }

    /// 同期の取り消し（復元）
    pub fn restore_sync(&self, history_id: &str) -> Result<SyncHistory, String> {
        let histories = self.get_histories()?;
        let target_history = histories
            .iter()
            .find(|h| h.id == history_id)
            .ok_or_else(|| format!("History not found: {}", history_id))?;

        if target_history.status == "restored" {
            return Err("This sync operation has already been restored.".to_string());
        }

        let tgt_p = Path::new(&target_history.target_path);

        // 安全チェック：現在のファイルが同期後の状態（after_hash）と一致しているか
        if tgt_p.exists() {
            let current_hash = Self::calculate_hash(tgt_p)?;
            if current_hash != target_history.after_hash {
                return Err("External change detected: The file has been modified since this sync operation. Restoration is blocked for safety.".to_string());
            }
        } else if !target_history.after_hash.is_empty() {
            return Err("External change detected: The file was expected to exist but is missing. Restoration is blocked for safety.".to_string());
        }

        // 復元処理：before スナップショットを実ファイルに書き戻す
        let snapshot_sync_dir = self.git_dir.join("snapshots").join(history_id);
        let file_name = tgt_p.file_name().unwrap();
        let before_file_path = snapshot_sync_dir.join("before").join(file_name);

        if !target_history.before_hash.is_empty() {
            // 同期前はファイルが存在していた場合：コピーして戻す
            if before_file_path.exists() {
                if let Some(parent) = tgt_p.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::copy(&before_file_path, tgt_p).map_err(|e| e.to_string())?;
            } else {
                return Err("Snapshot file not found in history repository.".to_string());
            }
        } else {
            // 同期前はファイルが存在していなかった場合（作成同期）：復元＝削除
            if tgt_p.exists() {
                fs::remove_file(tgt_p).map_err(|e| e.to_string())?;
            }
        }

        // 復元自体も履歴として保存
        let restore_sync_id = Uuid::new_v4().to_string();
        let restore_snapshot_dir = self.git_dir.join("snapshots").join(&restore_sync_id);
        fs::create_dir_all(&restore_snapshot_dir.join("before")).map_err(|e| e.to_string())?;
        fs::create_dir_all(&restore_snapshot_dir.join("after")).map_err(|e| e.to_string())?;

        // 復元前のファイル（＝同期後ファイル）を before にコピー
        if before_file_path.exists() {
            fs::copy(&before_file_path, restore_snapshot_dir.join("after").join(file_name)).map_err(|e| e.to_string())?;
        }
        // 復元後のファイル（＝同期前ファイル）を after にコピー
        if tgt_p.exists() {
            fs::copy(tgt_p, restore_snapshot_dir.join("before").join(file_name)).map_err(|e| e.to_string())?;
        }

        let mut restore_history = SyncHistory {
            id: restore_sync_id.clone(),
            session_id: target_history.session_id.clone(),
            mode: target_history.mode.clone(),
            sync_type: target_history.sync_type.clone(),
            direction: if target_history.direction == "leftToRight" {
                "rightToLeft".to_string()
            } else {
                "leftToRight".to_string()
            },
            source_path: target_history.target_path.clone(), // 復元元
            target_path: target_history.target_path.clone(), // 復元先
            before_hash: target_history.after_hash.clone(),
            after_hash: target_history.before_hash.clone(),
            commit_id: "".to_string(),
            created_at: Utc::now(),
            status: "restored".to_string(),
        };

        // 元の履歴レコードの状態を 'restored' に更新
        let mut histories = self.get_histories()?;
        if let Some(h) = histories.iter_mut().find(|x| x.id == history_id) {
            h.status = "restored".to_string();
        }

        // 復元履歴をリストに追加して保存
        histories.push(restore_history.clone());
        self.save_histories(&histories)?;

        // Gitコミット
        self.run_git(&["add", "."])?;
        let commit_msg = format!(
            "restore: revert sync operation {}\n\nTarget: {}\nTimestamp: {}",
            history_id, target_history.target_path, Utc::now().to_rfc3339()
        );
        self.run_git(&["commit", "-m", &commit_msg])?;

        // コミットハッシュを保存
        let commit_hash = self.run_git(&["rev-parse", "HEAD"])?;
        restore_history.commit_id = commit_hash.clone();

        // 最終的な JSON の更新
        let mut histories = self.get_histories()?;
        if let Some(h) = histories.iter_mut().find(|x| x.id == restore_sync_id) {
            h.commit_id = commit_hash.clone();
        }
        self.save_histories(&histories)?;

        // アメンドコミットで history.json を反映
        self.run_git(&["add", "history.json"])?;
        self.run_git(&["commit", "--amend", "--no-edit"])?;

        Ok(restore_history)
    }
}
