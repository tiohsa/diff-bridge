export interface DiffOptions {
  matchRule: 'relativePath' | 'fileName';
  ignoreWhitespace: boolean;
  ignoreLineEndingsInView: boolean;
  ignoreCase: boolean;
  useGitignore: boolean;
  includeExtensions: string[];
  contextLines: number;
  allowWsl2Paths: boolean;
  maxWarnFileSizeMb: number;
  maxComparableFileSizeMb: number;
}

export interface DiffFileResult {
  id: string;
  leftPath?: string;
  rightPath?: string;
  relativePath?: string;
  fileName: string;
  status: 'same' | 'modified' | 'leftOnly' | 'rightOnly' | 'uncomparable' | 'ambiguous';
  addedLines: number;
  deletedLines: number;
  modifiedLines: number;
  leftModifiedAt?: string;
  rightModifiedAt?: string;
  leftSize?: number;
  rightSize?: number;
  leftHash?: string;
  rightHash?: string;
  syncStatus: 'notSynced' | 'synced' | 'conflict' | 'restored';
}

export interface CompareSession {
  id: string;
  mode: 'bulk' | 'specified';
  leftRoot?: string;
  rightRoot?: string;
  leftFile?: string;
  rightFile?: string;
  leftPathType?: 'windows' | 'unc' | 'wsl2';
  rightPathType?: 'windows' | 'unc' | 'wsl2';
  createdAt: string;
  options: DiffOptions;
  results: DiffFileResult[];
}

export interface SyncHistory {
  id: string;
  sessionId: string;
  mode: 'bulk' | 'specified';
  syncType: 'hunk' | 'file';
  direction: 'leftToRight' | 'rightToLeft';
  sourcePath: string;
  targetPath: string;
  beforeHash: string;
  afterHash: string;
  commitId: string;
  createdAt: string;
  status: 'success' | 'failed' | 'restored';
}

export interface InlineChangeRange {
  start: number;
  end: number;
}

export interface DiffLine {
  leftLineNo?: number;
  rightLineNo?: number;
  tag: 'equal' | 'delete' | 'insert' | 'modify' | 'modify-delete' | 'modify-insert';
  content: string;
  inlineChanges?: InlineChangeRange[];
}

export interface FileDiffDetail {
  leftPath: string;
  rightPath: string;
  status: 'same' | 'modified';
  lines: DiffLine[];
}
