use crate::models::{CompareSession, DiffFileResult, DiffOptions, DiffLine, FileDiffDetail, InlineChangeRange};
use crate::git_history::GitHistoryManager;
use chrono::{Utc, DateTime};
use ignore::WalkBuilder;
use similar::{ChangeTag, TextDiff, Algorithm};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

pub struct DiffEngine;

impl DiffEngine {
    /// フォルダ内のファイルを再帰走査（.gitignore 独立適用）
    pub fn scan_directory(
        dir_path: &str,
        use_gitignore: bool,
        is_cancelled: Option<Arc<AtomicBool>>,
    ) -> Result<Vec<PathBuf>, String> {
        let root = Path::new(dir_path);
        if !root.exists() {
            return Err(format!("Directory does not exist: {}", dir_path));
        }

        let mut files = Vec::new();
        let mut builder = WalkBuilder::new(root);
        builder.git_ignore(use_gitignore);
        builder.hidden(true); // .gitignore や .git などの隠しファイルも走査（.git自体は後で除外）
        builder.parents(use_gitignore);

        let walker = builder.build();
        for result in walker {
            if let Some(ref cancelled) = is_cancelled {
                if cancelled.load(Ordering::Relaxed) {
                    return Err("Comparison cancelled by user".to_string());
                }
            }
            match result {
                Ok(entry) => {
                    let path = entry.path();
                    if path.is_file() {
                        // .git ディレクトリは常に除外
                        if path.components().any(|c| c.as_os_str() == ".git") {
                            continue;
                        }
                        files.push(path.to_path_buf());
                    }
                }
                Err(e) => {
                    // アクセス権限エラー等はログ等に出すか、無視する
                    println!("Scan warning: {}", e);
                }
            }
        }

        Ok(files)
    }

    /// パス種別の判定
    pub fn detect_path_type(path_str: &str) -> String {
        if path_str.starts_with("\\\\wsl$\\") || path_str.starts_with("\\\\wsl.localhost\\") {
            "wsl2".to_string()
        } else if path_str.starts_with("\\\\") {
            "unc".to_string()
        } else {
            "windows".to_string()
        }
    }

    /// ファイルがバイナリかどうか判定（ヌルバイトチェック）
    pub fn is_binary_file(path: &Path) -> bool {
        if let Ok(mut file) = File::open(path) {
            let mut buf = [0; 1024];
            if let Ok(n) = file.read(&mut buf) {
                for i in 0..n {
                    if buf[i] == 0 {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// UTF-8として読み込めるか検証
    pub fn is_utf8_file(path: &Path) -> bool {
        if let Ok(mut file) = File::open(path) {
            let mut buf = Vec::new();
            // 先頭から最大 64KB を読み込んで検証
            let mut handle = file.take(65536);
            if handle.read_to_end(&mut buf).is_ok() {
                return String::from_utf8(buf).is_ok();
            }
        }
        false
    }

    /// 2つのディレクトリの比較（一括diff）を実行
    pub fn compare_directories(
        left_root: &str,
        right_root: &str,
        options: DiffOptions,
        is_cancelled: Arc<AtomicBool>,
    ) -> Result<CompareSession, String> {
        let left_path = Path::new(left_root);
        let right_path = Path::new(right_root);

        let left_path_type = Some(Self::detect_path_type(left_root));
        let right_path_type = Some(Self::detect_path_type(right_root));

        // 左右のファイル走査
        let left_files = Self::scan_directory(left_root, options.use_gitignore, Some(is_cancelled.clone()))?;
        let right_files = Self::scan_directory(right_root, options.use_gitignore, Some(is_cancelled.clone()))?;

        // 相対パスへの変換とマップ構築
        let mut left_map = HashMap::new();
        for f in &left_files {
            if let Ok(rel) = f.strip_prefix(left_path) {
                let rel_str = rel.to_string_lossy().to_string().replace('\\', "/");
                left_map.insert(rel_str, f.clone());
            }
        }

        let mut right_map = HashMap::new();
        for f in &right_files {
            if let Ok(rel) = f.strip_prefix(right_path) {
                let rel_str = rel.to_string_lossy().to_string().replace('\\', "/");
                right_map.insert(rel_str, f.clone());
            }
        }

        let mut results = Vec::new();
        let mut processed_right = HashSet::new();

        // 比較照合ルールに基づいたペアリング
        if options.match_rule == "relativePath" {
            // 1. 標準：相対パス一致
            for (rel_path, left_file_path) in &left_map {
                if is_cancelled.load(Ordering::Relaxed) {
                    return Err("Comparison cancelled by user".to_string());
                }
                let right_file_path = right_map.get(rel_path);
                
                let result = Self::compare_file_pair(
                    Some(left_file_path),
                    right_file_path,
                    Some(rel_path),
                    &options,
                )?;
                
                results.push(result);
                if right_file_path.is_some() {
                    processed_right.insert(rel_path.clone());
                }
            }

            // 右側にのみ存在するファイル
            for (rel_path, right_file_path) in &right_map {
                if is_cancelled.load(Ordering::Relaxed) {
                    return Err("Comparison cancelled by user".to_string());
                }
                if !processed_right.contains(rel_path) {
                    let result = Self::compare_file_pair(
                        None,
                        Some(right_file_path),
                        Some(rel_path),
                        &options,
                    )?;
                    results.push(result);
                }
            }
        } else {
            // 2. オプション：ファイル名一致（配置場所が違っても同名なら比較）
            // まずファイル名からパスリストへのマップを作成
            let mut left_by_name: HashMap<String, Vec<(String, PathBuf)>> = HashMap::new();
            for (rel, path) in &left_map {
                let file_name = path.file_name().unwrap().to_string_lossy().to_string();
                left_by_name.entry(file_name).or_default().push((rel.clone(), path.clone()));
            }

            let mut right_by_name: HashMap<String, Vec<(String, PathBuf)>> = HashMap::new();
            for (rel, path) in &right_map {
                let file_name = path.file_name().unwrap().to_string_lossy().to_string();
                right_by_name.entry(file_name).or_default().push((rel.clone(), path.clone()));
            }

            let all_file_names: HashSet<String> = left_by_name.keys().cloned().chain(right_by_name.keys().cloned()).collect();

            for name in all_file_names {
                if is_cancelled.load(Ordering::Relaxed) {
                    return Err("Comparison cancelled by user".to_string());
                }
                let left_list = left_by_name.get(&name);
                let right_list = right_by_name.get(&name);

                match (left_list, right_list) {
                    (Some(left_entries), Some(right_entries)) => {
                        // 左右両方に存在する同名ファイル
                        if left_entries.len() == 1 && right_entries.len() == 1 {
                            // 1対1でペアリング可能
                            let (l_rel, l_path) = &left_entries[0];
                            let (r_rel, r_path) = &right_entries[0];
                            let result = Self::compare_file_pair(
                                Some(l_path),
                                Some(r_path),
                                Some(l_rel), // 代表して左側の相対パスを使用
                                &options,
                            )?;
                            results.push(result);
                        } else {
                            // 1対多、多対多などで曖昧なマッチング
                            for (l_rel, l_path) in left_entries {
                                let mut result = Self::compare_file_pair(
                                    Some(l_path),
                                    None,
                                    Some(l_rel),
                                    &options,
                                )?;
                                result.status = "ambiguous".to_string();
                                results.push(result);
                            }
                            for (r_rel, r_path) in right_entries {
                                let mut result = Self::compare_file_pair(
                                    None,
                                    Some(r_path),
                                    Some(r_rel),
                                    &options,
                                )?;
                                result.status = "ambiguous".to_string();
                                results.push(result);
                            }
                        }
                    }
                    (Some(left_entries), None) => {
                        // 左のみ
                        for (l_rel, l_path) in left_entries {
                            let result = Self::compare_file_pair(
                                Some(l_path),
                                None,
                                Some(l_rel),
                                &options,
                            )?;
                            results.push(result);
                        }
                    }
                    (None, Some(right_entries)) => {
                        // 右のみ
                        for (r_rel, r_path) in right_entries {
                            let result = Self::compare_file_pair(
                                None,
                                Some(r_path),
                                Some(r_rel),
                                &options,
                            )?;
                            results.push(result);
                        }
                    }
                    (None, None) => {}
                }
            }
        }

        // 相対パス順にソートして見やすく
        results.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

        Ok(CompareSession {
            id: Uuid::new_v4().to_string(),
            mode: "bulk".to_string(),
            left_root: Some(left_root.to_string()),
            right_root: Some(right_root.to_string()),
            left_file: None,
            right_file: None,
            left_path_type,
            right_path_type,
            created_at: Utc::now(),
            options,
            results,
        })
    }

    /// 単一のファイルペアの比較判定
    fn compare_file_pair(
        left_path: Option<&PathBuf>,
        right_path: Option<&PathBuf>,
        rel_path: Option<&str>,
        options: &DiffOptions,
    ) -> Result<DiffFileResult, String> {
        let file_name = left_path
            .or(right_path)
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let mut result = DiffFileResult {
            id: Uuid::new_v4().to_string(),
            left_path: left_path.map(|p| p.to_string_lossy().to_string()),
            right_path: right_path.map(|p| p.to_string_lossy().to_string()),
            relative_path: rel_path.map(|s| s.to_string()),
            file_name,
            status: "same".to_string(),
            added_lines: 0,
            deleted_lines: 0,
            modified_lines: 0,
            left_modified_at: None,
            right_modified_at: None,
            left_size: None,
            right_size: None,
            left_hash: None,
            right_hash: None,
            sync_status: "notSynced".to_string(),
        };

        // メタデータの取得
        if let Some(lp) = left_path {
            if let Ok(meta) = fs::metadata(lp) {
                result.left_size = Some(meta.len());
                if let Ok(modified) = meta.modified() {
                    result.left_modified_at = Some(DateTime::from(modified));
                }
            }
            result.left_hash = Some(GitHistoryManager::calculate_hash(lp)?);
        }

        if let Some(rp) = right_path {
            if let Ok(meta) = fs::metadata(rp) {
                result.right_size = Some(meta.len());
                if let Ok(modified) = meta.modified() {
                    result.right_modified_at = Some(DateTime::from(modified));
                }
            }
            result.right_hash = Some(GitHistoryManager::calculate_hash(rp)?);
        }

        // 拡張子フィルタ（指定がある場合）
        if !options.include_extensions.is_empty() {
            let ext = Path::new(&result.file_name)
                .extension()
                .map(|e| e.to_string_lossy().to_string().to_lowercase())
                .unwrap_or_default();
            if !options.include_extensions.iter().any(|x| x.to_lowercase() == ext) {
                result.status = "uncomparable".to_string();
                return Ok(result);
            }
        }

        // 状態判定
        match (left_path, right_path) {
            (Some(lp), Some(rp)) => {
                // 左右両方に存在
                let l_size = result.left_size.unwrap_or(0) as f64 / 1024.0 / 1024.0;
                let r_size = result.right_size.unwrap_or(0) as f64 / 1024.0 / 1024.0;

                // 大容量ファイルチェック
                if l_size > options.max_comparable_file_size_mb || r_size > options.max_comparable_file_size_mb {
                    result.status = "uncomparable".to_string();
                } else if Self::is_binary_file(lp) || Self::is_binary_file(rp) {
                    // バイナリファイル
                    result.status = "uncomparable".to_string();
                } else if !Self::is_utf8_file(lp) || !Self::is_utf8_file(rp) {
                    // UTF-8以外
                    result.status = "uncomparable".to_string();
                } else {
                    // テキストファイル比較
                    let l_hash = result.left_hash.as_ref().unwrap();
                    let r_hash = result.right_hash.as_ref().unwrap();

                    if l_hash == r_hash {
                        result.status = "same".to_string();
                    } else {
                        // 差分の簡易行数算出
                        let l_text = fs::read_to_string(lp).map_err(|e| e.to_string())?;
                        let r_text = fs::read_to_string(rp).map_err(|e| e.to_string())?;

                        // オプションによる正規化
                        let norm_l = Self::normalize_text(&l_text, options);
                        let norm_r = Self::normalize_text(&r_text, options);

                        let diff = TextDiff::configure()
                            .algorithm(Algorithm::Myers)
                            .diff_lines(&norm_l, &norm_r);

                        let mut added = 0;
                        let mut deleted = 0;

                        for change in diff.iter_all_changes() {
                            match change.tag() {
                                ChangeTag::Insert => added += 1,
                                ChangeTag::Delete => deleted += 1,
                                ChangeTag::Equal => {}
                            }
                        }

                        if added == 0 && deleted == 0 {
                            // 正規化後（空白無視など）に一致した場合
                            result.status = "same".to_string();
                        } else {
                            result.status = "modified".to_string();
                            result.added_lines = added;
                            result.deleted_lines = deleted;
                            // 簡易的に modified_lines も算出（追加と削除のペアを「変更」と数えることも可能だが、通常は追加・削除行数で十分）
                        }
                    }
                }
            }
            (Some(_), None) => {
                result.status = "leftOnly".to_string();
            }
            (None, Some(_)) => {
                result.status = "rightOnly".to_string();
            }
            (None, None) => {
                result.status = "uncomparable".to_string();
            }
        }

        Ok(result)
    }

    /// テキストの正規化オプション適用
    fn normalize_text(text: &str, options: &DiffOptions) -> String {
        let mut normalized = text.to_string();

        if options.ignore_line_endings_in_view {
            normalized = normalized.replace("\r\n", "\n");
        }

        if options.ignore_case {
            normalized = normalized.to_lowercase();
        }

        if options.ignore_whitespace {
            // 各行の前後空白および連続空白を無視するために、行ごとに処理する
            let lines: Vec<String> = normalized
                .lines()
                .map(|line| {
                    let trimmed = line.trim();
                    // 連続する空白を1つのスペースにする
                    let mut cleared = String::new();
                    let mut prev_is_space = false;
                    for c in trimmed.chars() {
                        if c.is_whitespace() {
                            if !prev_is_space {
                                cleared.push(' ');
                                prev_is_space = true;
                            }
                        } else {
                            cleared.push(c);
                            prev_is_space = false;
                        }
                    }
                    cleared
                })
                .collect();
            normalized = lines.join("\n");
        }

        normalized
    }

    /// インライン差分（文字単位差分）の算出
    fn compute_inline_diff(left: &str, right: &str) -> (Vec<InlineChangeRange>, Vec<InlineChangeRange>) {
        let diff = TextDiff::configure()
            .algorithm(Algorithm::Myers)
            .diff_chars(left, right);

        let mut left_ranges = Vec::new();
        let mut right_ranges = Vec::new();

        let mut left_idx = 0;
        let mut right_idx = 0;

        for change in diff.iter_all_changes() {
            let len = change.value().chars().count();
            match change.tag() {
                ChangeTag::Delete => {
                    left_ranges.push(InlineChangeRange {
                        start: left_idx,
                        end: left_idx + len,
                    });
                    left_idx += len;
                }
                ChangeTag::Insert => {
                    right_ranges.push(InlineChangeRange {
                        start: right_idx,
                        end: right_idx + len,
                    });
                    right_idx += len;
                }
                ChangeTag::Equal => {
                    left_idx += len;
                    right_idx += len;
                }
            }
        }

        (left_ranges, right_ranges)
    }

    /// 2ファイルの行ベース差分詳細の生成（指定diff及び差分詳細画面用）
    pub fn compare_files(
        left_file_path: &str,
        right_file_path: &str,
        options: DiffOptions,
    ) -> Result<FileDiffDetail, String> {
        let lp = Path::new(left_file_path);
        let rp = Path::new(right_file_path);

        if !lp.exists() || !rp.exists() {
            return Err("One or both files do not exist for detailed diff.".to_string());
        }

        if Self::is_binary_file(lp) || Self::is_binary_file(rp) {
            return Err("Cannot display diff for binary files.".to_string());
        }

        let left_raw = fs::read_to_string(lp).map_err(|e| e.to_string())?;
        let right_raw = fs::read_to_string(rp).map_err(|e| e.to_string())?;

        // 画面上での改行コード扱い
        let left_text = if options.ignore_line_endings_in_view {
            left_raw.replace("\r\n", "\n")
        } else {
            left_raw
        };
        let right_text = if options.ignore_line_endings_in_view {
            right_raw.replace("\r\n", "\n")
        } else {
            right_raw
        };

        // TextDiffの構築（正規化は `normalize_text` ではなく、行比較の際のみオプション適用）
        // オプションを適用して比較用テキストを作成
        let norm_l = Self::normalize_text(&left_text, &options);
        let norm_r = Self::normalize_text(&right_text, &options);

        // 比較自体は正規化テキストで行い、表示には原文を使う
        let norm_l_lines: Vec<&str> = norm_l.lines().collect();
        let norm_r_lines: Vec<&str> = norm_r.lines().collect();

        let diff = TextDiff::configure()
            .algorithm(Algorithm::Myers)
            .diff_slices(&norm_l_lines, &norm_r_lines);

        let left_lines: Vec<&str> = left_text.lines().collect();
        let right_lines: Vec<&str> = right_text.lines().collect();

        let mut diff_lines = Vec::new();
        let mut left_no = 1;
        let mut right_no = 1;

        // 全ての変更行を取得してマッピング
        // Myersアルゴリズムのオペレーションに沿って、削除と追加の連続ブロックを検出し、「modify」としてインライン差分を施す
        let ops = diff.ops();
        for op in ops {
            let change_tag = op.tag();
            match change_tag {
                similar::DiffTag::Equal => {
                    let left_range = op.old_range();
                    for idx in left_range {
                        diff_lines.push(DiffLine {
                            left_line_no: Some(left_no),
                            right_line_no: Some(right_no),
                            tag: "equal".to_string(),
                            content: left_lines.get(idx).cloned().unwrap_or("").to_string(),
                            inline_changes: None,
                        });
                        left_no += 1;
                        right_no += 1;
                    }
                }
                similar::DiffTag::Delete => {
                    let left_range = op.old_range();
                    for idx in left_range {
                        diff_lines.push(DiffLine {
                            left_line_no: Some(left_no),
                            right_line_no: None,
                            tag: "delete".to_string(),
                            content: left_lines.get(idx).cloned().unwrap_or("").to_string(),
                            inline_changes: None,
                        });
                        left_no += 1;
                    }
                }
                similar::DiffTag::Insert => {
                    let right_range = op.new_range();
                    for idx in right_range {
                        diff_lines.push(DiffLine {
                            left_line_no: None,
                            right_line_no: Some(right_no),
                            tag: "insert".to_string(),
                            content: right_lines.get(idx).cloned().unwrap_or("").to_string(),
                            inline_changes: None,
                        });
                        right_no += 1;
                    }
                }
                similar::DiffTag::Replace => {
                    // modify 相当。近接する削除と追加
                    let left_range = op.old_range();
                    let right_range = op.new_range();

                    let l_len = left_range.len();
                    let r_len = right_range.len();
                    let max_len = l_len.max(r_len);

                    // 左右で1行ずつのペアに分解して、インライン差分を実行
                    for i in 0..max_len {
                        if i < l_len && i < r_len {
                            let l_idx = left_range.start + i;
                            let r_idx = right_range.start + i;

                            let l_str = left_lines.get(l_idx).cloned().unwrap_or("");
                            let r_str = right_lines.get(r_idx).cloned().unwrap_or("");

                            let (l_inline, r_inline) = Self::compute_inline_diff(l_str, r_str);

                            diff_lines.push(DiffLine {
                                left_line_no: Some(left_no),
                                right_line_no: None, // 2ペイン並列表示のために分けて登録（フロントエンドで調整）
                                tag: "modify-delete".to_string(), // 削除側
                                content: l_str.to_string(),
                                inline_changes: Some(l_inline),
                            });

                            diff_lines.push(DiffLine {
                                left_line_no: None,
                                right_line_no: Some(right_no),
                                tag: "modify-insert".to_string(), // 追加側
                                content: r_str.to_string(),
                                inline_changes: Some(r_inline),
                            });

                            left_no += 1;
                            right_no += 1;
                        } else if i < l_len {
                            let l_idx = left_range.start + i;
                            diff_lines.push(DiffLine {
                                left_line_no: Some(left_no),
                                right_line_no: None,
                                tag: "delete".to_string(),
                                content: left_lines.get(l_idx).cloned().unwrap_or("").to_string(),
                                inline_changes: None,
                            });
                            left_no += 1;
                        } else {
                            let r_idx = right_range.start + i;
                            diff_lines.push(DiffLine {
                                left_line_no: None,
                                right_line_no: Some(right_no),
                                tag: "insert".to_string(),
                                content: right_lines.get(r_idx).cloned().unwrap_or("").to_string(),
                                inline_changes: None,
                            });
                            right_no += 1;
                        }
                    }
                }
            }
        }

        // ファイルステータスの判定
        let left_hash = GitHistoryManager::calculate_hash(lp)?;
        let right_hash = GitHistoryManager::calculate_hash(rp)?;
        let status = if left_hash == right_hash { "same" } else { "modified" };

        Ok(FileDiffDetail {
            left_path: left_file_path.to_string(),
            right_path: right_file_path.to_string(),
            status: status.to_string(),
            lines: diff_lines,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_text() {
        let options = DiffOptions {
            match_rule: "relativePath".to_string(),
            ignore_whitespace: true,
            ignore_line_endings_in_view: true,
            ignore_case: true,
            use_gitignore: false,
            include_extensions: vec![],
            context_lines: 3,
            allow_wsl2_paths: true,
            max_warn_file_size_mb: 10.0,
            max_comparable_file_size_mb: 100.0,
        };

        let raw = "  Hello   World \r\n";
        let norm = DiffEngine::normalize_text(raw, &options);
        assert_eq!(norm, "hello world");
    }
}
