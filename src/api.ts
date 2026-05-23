import { invoke } from "@tauri-apps/api/core";
import { CompareSession, DiffOptions, FileDiffDetail, SyncHistory } from "./types";

export async function selectDirectory(): Promise<string | null> {
  return invoke<string | null>("select_directory");
}

export async function selectFile(): Promise<string | null> {
  return invoke<string | null>("select_file");
}

export async function compareDirectories(
  left: string,
  right: string,
  options: DiffOptions
): Promise<CompareSession> {
  return invoke<CompareSession>("compare_directories", { left, right, options });
}

export async function compareFiles(
  left: string,
  right: string,
  options: DiffOptions
): Promise<FileDiffDetail> {
  return invoke<FileDiffDetail>("compare_files", { left, right, options });
}

export async function syncFile(
  sessionId: string,
  mode: 'bulk' | 'specified',
  syncType: 'file' | 'hunk',
  direction: 'leftToRight' | 'rightToLeft',
  sourcePath: string,
  targetPath: string,
  beforeHash: string
): Promise<SyncHistory> {
  return invoke<SyncHistory>("sync_file", {
    sessionId,
    mode,
    syncType,
    direction,
    sourcePath,
    targetPath,
    beforeHash,
  });
}

export async function getSyncHistories(): Promise<SyncHistory[]> {
  return invoke<SyncHistory[]>("get_sync_histories");
}

export async function restoreSync(historyId: string): Promise<SyncHistory> {
  return invoke<SyncHistory>("restore_sync", { historyId });
}

export async function cancelCompare(): Promise<void> {
  return invoke<void>("cancel_compare");
}

