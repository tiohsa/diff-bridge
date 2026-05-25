use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSession {
    pub id: String,
    pub mode: String, // "bulk" | "specified"
    pub left_root: Option<String>,
    pub right_root: Option<String>,
    pub left_file: Option<String>,
    pub right_file: Option<String>,
    pub left_path_type: Option<String>, // "windows" | "unc" | "wsl2"
    pub right_path_type: Option<String>, // "windows" | "unc" | "wsl2"
    pub created_at: DateTime<Utc>,
    pub options: DiffOptions,
    pub results: Vec<DiffFileResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileResult {
    pub id: String,
    pub left_path: Option<String>,
    pub right_path: Option<String>,
    pub relative_path: Option<String>,
    pub file_name: String,
    pub status: String, // "same" | "modified" | "leftOnly" | "rightOnly" | "uncomparable" | "ambiguous"
    pub added_lines: usize,
    pub deleted_lines: usize,
    pub modified_lines: usize,
    pub left_modified_at: Option<DateTime<Utc>>,
    pub right_modified_at: Option<DateTime<Utc>>,
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
    pub left_hash: Option<String>,
    pub right_hash: Option<String>,
    pub sync_status: String, // "notSynced" | "synced" | "conflict" | "restored"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    pub match_rule: String, // "relativePath" | "fileName"
    pub ignore_whitespace: bool,
    pub ignore_line_endings_in_view: bool,
    pub ignore_case: bool,
    pub use_gitignore: bool,
    pub include_extensions: Vec<String>,
    pub context_lines: usize,
    pub allow_wsl2_paths: bool,
    pub max_warn_file_size_mb: f64,
    pub max_comparable_file_size_mb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistory {
    pub id: String,
    pub session_id: String,
    pub mode: String,      // "bulk" | "specified"
    pub sync_type: String, // "hunk" | "file"
    pub direction: String, // "leftToRight" | "rightToLeft"
    pub source_path: String,
    pub target_path: String,
    pub before_hash: String,
    pub after_hash: String,
    pub commit_id: String,
    pub created_at: DateTime<Utc>,
    pub status: String, // "success" | "failed" | "restored"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFolderEntry {
    pub source_path: String,
    pub target_path: String,
    pub relative_path: String,
    pub before_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineChangeRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub left_line_no: Option<usize>,
    pub right_line_no: Option<usize>,
    pub tag: String, // "equal" | "delete" | "insert" | "modify"
    pub content: String,
    pub inline_changes: Option<Vec<InlineChangeRange>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffDetail {
    pub left_path: String,
    pub right_path: String,
    pub status: String,
    pub lines: Vec<DiffLine>,
}
