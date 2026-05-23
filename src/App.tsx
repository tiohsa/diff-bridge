import React, { useState, useEffect, useRef } from "react";
import {
  selectDirectory,
  selectFile,
  compareDirectories,
  compareFiles,
  syncFile,
  getSyncHistories,
  restoreSync,
  cancelCompare
} from "./api";
import { CompareSession, DiffFileResult, DiffOptions, FileDiffDetail, SyncHistory, DiffLine } from "./types";
import "./App.css";

// ==========================================================================
// Sync Folder Tree structures and helper functions
// ==========================================================================
interface TreeNode {
  type: 'file' | 'folder';
  name: string;
  relativePath: string;
  status: 'same' | 'modified' | 'leftOnly' | 'rightOnly' | 'uncomparable' | 'ambiguous';
  children?: { [name: string]: TreeNode };
  fileResult?: DiffFileResult;
}

interface FlatTreeNode {
  key: string;
  name: string;
  type: 'file' | 'folder';
  depth: number;
  relativePath: string;
  status: 'same' | 'modified' | 'leftOnly' | 'rightOnly' | 'uncomparable' | 'ambiguous';
  fileResult?: DiffFileResult;
  hasChildren: boolean;
}

const buildTreeData = (results: DiffFileResult[]): TreeNode => {
  const root: TreeNode = {
    type: 'folder',
    name: 'root',
    relativePath: '',
    status: 'same',
    children: {}
  };

  results.forEach(item => {
    const pathStr = item.relativePath || item.fileName;
    const parts = pathStr.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentRelative = parts.slice(0, i + 1).join('/');

      if (!current.children) current.children = {};

      if (isLast) {
        current.children[part] = {
          type: 'file',
          name: part,
          relativePath: pathStr,
          status: item.status,
          fileResult: item
        };
      } else {
        if (!current.children[part]) {
          current.children[part] = {
            type: 'folder',
            name: part,
            relativePath: currentRelative,
            status: 'same',
            children: {}
          };
        }
        current = current.children[part];
      }
    }
  });

  const propagateStatus = (node: TreeNode): string => {
    if (node.type === 'file') return node.status;

    let hasModified = false;
    let hasLeftOnly = false;
    let hasRightOnly = false;
    let hasAmbiguous = false;

    if (node.children) {
      Object.values(node.children).forEach(child => {
        const childStatus = propagateStatus(child);
        if (childStatus === 'modified') hasModified = true;
        if (childStatus === 'leftOnly') hasLeftOnly = true;
        if (childStatus === 'rightOnly') hasRightOnly = true;
        if (childStatus === 'ambiguous') hasAmbiguous = true;
      });
    }

    if (hasModified) node.status = 'modified';
    else if (hasLeftOnly && hasRightOnly) node.status = 'modified';
    else if (hasLeftOnly) node.status = 'leftOnly';
    else if (hasRightOnly) node.status = 'rightOnly';
    else if (hasAmbiguous) node.status = 'ambiguous';

    return node.status;
  };

  propagateStatus(root);
  return root;
};

const flattenTree = (
  node: TreeNode,
  expandedPaths: string[],
  depth: number = 0,
  list: FlatTreeNode[] = []
): FlatTreeNode[] => {
  if (node.name === 'root') {
    if (node.children) {
      const sortedKeys = Object.keys(node.children).sort((a, b) => {
        const childA = node.children![a];
        const childB = node.children![b];
        if (childA.type !== childB.type) {
          return childA.type === 'folder' ? -1 : 1;
        }
        return a.localeCompare(b);
      });

      sortedKeys.forEach(key => {
        flattenTree(node.children![key], expandedPaths, depth, list);
      });
    }
    return list;
  }

  const hasChildren = node.type === 'folder' && node.children && Object.keys(node.children).length > 0;

  list.push({
    key: node.relativePath,
    name: node.name,
    type: node.type,
    depth,
    relativePath: node.relativePath,
    status: node.status,
    fileResult: node.fileResult,
    hasChildren: !!hasChildren
  });

  if (node.type === 'folder' && expandedPaths.includes(node.relativePath) && node.children) {
    const sortedKeys = Object.keys(node.children).sort((a, b) => {
      const childA = node.children![a];
      const childB = node.children![b];
      if (childA.type !== childB.type) {
        return childA.type === 'folder' ? -1 : 1;
      }
      return a.localeCompare(b);
    });

    sortedKeys.forEach(key => {
      flattenTree(node.children![key], expandedPaths, depth + 1, list);
    });
  }

  return list;
};

const defaultOptions: DiffOptions = {
  matchRule: "relativePath",
  ignoreWhitespace: false,
  ignoreLineEndingsInView: true,
  ignoreCase: false,
  useGitignore: true,
  includeExtensions: [],
  contextLines: 3,
  allowWsl2Paths: true,
  maxWarnFileSizeMb: 10,
  maxComparableFileSizeMb: 100
};

export default function App() {
  // Navigation State
  const [view, setView] = useState<'home' | 'bulk-diff' | 'specified-diff' | 'diff-detail' | 'history' | 'settings'>('home');

  // Comparison State
  const [leftRoot, setLeftRoot] = useState<string>("");
  const [rightRoot, setRightRoot] = useState<string>("");
  const [leftFile, setLeftFile] = useState<string>("");
  const [rightFile, setRightFile] = useState<string>("");
  const [options, setOptions] = useState<DiffOptions>(defaultOptions);
  const [showOptions, setShowOptions] = useState<boolean>(false);

  // Results State
  const [session, setSession] = useState<CompareSession | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'modified' | 'same' | 'leftOnly' | 'rightOnly' | 'uncomparable'>('all');
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [viewMode, setViewMode] = useState<'tree' | 'table'>('tree');
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);


  // Detailed Diff State
  const [activeFileResult, setActiveFileResult] = useState<DiffFileResult | null>(null);
  const [activeDiffDetail, setActiveDiffDetail] = useState<FileDiffDetail | null>(null);


  // Sync Confirmation Dialog State
  const [showSyncConfirm, setShowSyncConfirm] = useState<boolean>(false);
  const [syncDirection, setSyncDirection] = useState<'leftToRight' | 'rightToLeft' | null>(null);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Histories State
  const [histories, setHistories] = useState<SyncHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);

  // Recent Sessions (Session storage simulation)
  const [recentSessions, setRecentSessions] = useState<CompareSession[]>([]);

  // Split Pane Refs for synchronized scrolling
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const isScrollingLeft = useRef<boolean>(false);
  const isScrollingRight = useRef<boolean>(false);

  // Sync scroll for side-by-side folder tree
  const leftTreeRef = useRef<HTMLDivElement>(null);
  const rightTreeRef = useRef<HTMLDivElement>(null);
  const isScrollingTreeLeft = useRef<boolean>(false);
  const isScrollingTreeRight = useRef<boolean>(false);

  const handleLeftTreeScroll = () => {
    if (isScrollingTreeRight.current) return;
    isScrollingTreeLeft.current = true;
    if (leftTreeRef.current && rightTreeRef.current) {
      rightTreeRef.current.scrollTop = leftTreeRef.current.scrollTop;
      rightTreeRef.current.scrollLeft = leftTreeRef.current.scrollLeft;
    }
    setTimeout(() => { isScrollingTreeLeft.current = false; }, 50);
  };

  const handleRightTreeScroll = () => {
    if (isScrollingTreeLeft.current) return;
    isScrollingTreeRight.current = true;
    if (leftTreeRef.current && rightTreeRef.current) {
      leftTreeRef.current.scrollTop = rightTreeRef.current.scrollTop;
      leftTreeRef.current.scrollLeft = rightTreeRef.current.scrollLeft;
    }
    setTimeout(() => { isScrollingTreeRight.current = false; }, 50);
  };

  const togglePath = (path: string) => {
    setExpandedPaths(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    );
  };


  // Load history & recent sessions on start
  useEffect(() => {
    loadHistories();
    const stored = localStorage.getItem("diff_recent_sessions");
    if (stored) {
      try {
        setRecentSessions(JSON.parse(stored));
      } catch (e) {
        console.error(e);
      }
    }
  }, []);

  const loadHistories = async () => {
    setHistoryLoading(true);
    try {
      const list = await getSyncHistories();
      // 最新の履歴を上に
      setHistories(list.reverse());
    } catch (e: any) {
      console.error(e);
    } finally {
      setHistoryLoading(false);
    }
  };

  // Synchronized Scrolling logic
  const handleLeftScroll = () => {
    if (isScrollingRight.current) return;
    isScrollingLeft.current = true;
    if (leftPaneRef.current && rightPaneRef.current) {
      rightPaneRef.current.scrollTop = leftPaneRef.current.scrollTop;
      rightPaneRef.current.scrollLeft = leftPaneRef.current.scrollLeft;
    }
    setTimeout(() => { isScrollingLeft.current = false; }, 50);
  };

  const handleRightScroll = () => {
    if (isScrollingLeft.current) return;
    isScrollingRight.current = true;
    if (leftPaneRef.current && rightPaneRef.current) {
      leftPaneRef.current.scrollTop = rightPaneRef.current.scrollTop;
      leftPaneRef.current.scrollLeft = rightPaneRef.current.scrollLeft;
    }
    setTimeout(() => { isScrollingRight.current = false; }, 50);
  };

  // Choose Path Handlers
  const handleSelectLeftDir = async () => {
    try {
      const path = await selectDirectory();
      if (path) setLeftRoot(path);
    } catch (e: any) {
      setErrorMsg(e.toString());
    }
  };

  const handleSelectRightDir = async () => {
    try {
      const path = await selectDirectory();
      if (path) setRightRoot(path);
    } catch (e: any) {
      setErrorMsg(e.toString());
    }
  };

  const handleSelectLeftFile = async () => {
    try {
      const path = await selectFile();
      if (path) setLeftFile(path);
    } catch (e: any) {
      setErrorMsg(e.toString());
    }
  };

  const handleSelectRightFile = async () => {
    try {
      const path = await selectFile();
      if (path) setRightFile(path);
    } catch (e: any) {
      setErrorMsg(e.toString());
    }
  };

  // Directory Compare Execution
  const handleCompareDirs = async () => {
    if (!leftRoot || !rightRoot) {
      setErrorMsg("左右両方の比較対象ディレクトリを選択してください。");
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await compareDirectories(leftRoot, rightRoot, options);
      setSession(res);

      // フォルダ構造の自動全展開パスを収集して初期設定
      const pathsToExpand = Array.from(new Set(res.results.map(r => {
        const parts = (r.relativePath || r.fileName).split('/');
        const folders = [];
        for (let i = 0; i < parts.length - 1; i++) {
          folders.push(parts.slice(0, i + 1).join('/'));
        }
        return folders;
      }).flat()));
      setExpandedPaths(pathsToExpand);

      // 最近使ったセッションに追加
      const updatedSessions = [res, ...recentSessions.filter(s => s.leftRoot !== leftRoot || s.rightRoot !== rightRoot)].slice(0, 5);
      setRecentSessions(updatedSessions);
      localStorage.setItem("diff_recent_sessions", JSON.stringify(updatedSessions));
    } catch (e: any) {
      setErrorMsg(e.toString());
    } finally {
      setLoading(false);
    }
  };

  // File Compare Execution (Specified Mode)
  const handleCompareFiles = async () => {
    if (!leftFile || !rightFile) {
      setErrorMsg("左右両方の比較対象ファイルを選択してください。");
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const detail = await compareFiles(leftFile, rightFile, options);
      
      // 擬似的にファイル比較結果のレコードを生成
      const fakeResult: DiffFileResult = {
        id: "specified-file-sync",
        leftPath: leftFile,
        rightPath: rightFile,
        fileName: leftFile.split(/[/\\]/).pop() || "file",
        status: detail.status === "same" ? "same" : "modified",
        addedLines: detail.lines.filter(l => l.tag.includes("insert")).length,
        deletedLines: detail.lines.filter(l => l.tag.includes("delete")).length,
        modifiedLines: 0,
        syncStatus: "notSynced"
      };

      setActiveFileResult(fakeResult);
      setActiveDiffDetail(detail);
      setView('diff-detail');
    } catch (e: any) {
      setErrorMsg(e.toString());
    } finally {
      setLoading(false);
    }
  };

  // Show detailed diff for a file in bulk results list
  const handleShowFileDiff = async (fileResult: DiffFileResult) => {
    if (fileResult.status === "uncomparable") {
      alert("バイナリファイル、大容量ファイル、またはエンコード未対応のため、差分詳細を表示できません。");
      return;
    }

    setErrorMsg(null);
    try {
      const leftPath = fileResult.leftPath || "";
      const rightPath = fileResult.rightPath || "";
      
      // 片側のみファイルの場合の擬似パス処理
      const realLeft = leftPath || rightPath; // 左のみなら左、右のみなら右（ダミー）
      const realRight = rightPath || leftPath;

      const detail = await compareFiles(realLeft, realRight, options);
      setActiveFileResult(fileResult);
      setActiveDiffDetail(detail);
      setView('diff-detail');
    } catch (e: any) {
      setErrorMsg(e.toString());
    }
  };

  // Sync execution
  const handleExecuteSync = async () => {
    if (!activeFileResult || !syncDirection) return;
    setSyncing(true);
    setErrorMsg(null);
    try {
      const isLeftToRight = syncDirection === "leftToRight";
      
      // 同期元のファイルパスと同期先のファイルパス
      let sourcePath = "";
      let targetPath = "";
      let beforeHash = "";

      if (isLeftToRight) {
        sourcePath = activeFileResult.leftPath || "";
        // もし右側にまだファイルが存在しない（leftOnlyの作成同期）場合、
        // 右側ルートディレクトリの下に相対パスで作成
        targetPath = activeFileResult.rightPath || 
          `${session?.rightRoot}/${activeFileResult.relativePath}`;
        beforeHash = activeFileResult.rightHash || "";
      } else {
        sourcePath = activeFileResult.rightPath || "";
        targetPath = activeFileResult.leftPath || 
          `${session?.leftRoot}/${activeFileResult.relativePath}`;
        beforeHash = activeFileResult.leftHash || "";
      }

      await syncFile(
        session?.id || "manual-sync",
        session?.mode || "specified",
        "file",
        syncDirection,
        sourcePath,
        targetPath,
        beforeHash
      );

      setShowSyncConfirm(false);
      alert("同期処理が完了しました。履歴にGitコミットとして保存されました。");
      
      // 同期完了後のリフレッシュ
      if (session && session.leftRoot && session.rightRoot) {
        // 一括diffモードなら再度比較を走らせてリスト更新
        await handleCompareDirs();
        setView('bulk-diff');
      } else {
        // 指定diffモードならホームへ
        setView('home');
      }
      loadHistories();
    } catch (e: any) {
      setErrorMsg(e.toString());
      alert(`同期エラー: ${e.toString()}`);
    } finally {
      setSyncing(false);
    }
  };

  // Restore sync operation
  const handleRestore = async (historyId: string) => {
    if (!confirm("本当にこの同期操作を元に戻しますか？")) return;
    setErrorMsg(null);
    try {
      await restoreSync(historyId);
      alert("復元に成功しました。復元操作も履歴に保存されました。");
      loadHistories();
    } catch (e: any) {
      setErrorMsg(e.toString());
      alert(`復元エラー: ${e.toString()}`);
    }
  };

  // Filtered results list
  const filteredResults = session
    ? session.results.filter(item => {
        // 検索クエリフィルタ
        if (searchQuery && !item.fileName.toLowerCase().includes(searchQuery.toLowerCase()) && 
            !(item.relativePath && item.relativePath.toLowerCase().includes(searchQuery.toLowerCase()))) {
          return false;
        }
        // タブステータスフィルタ
        if (filter === "all") return true;
        if (filter === "modified") return item.status === "modified";
        if (filter === "same") return item.status === "same";
        if (filter === "leftOnly") return item.status === "leftOnly";
        if (filter === "rightOnly") return item.status === "rightOnly";
        if (filter === "uncomparable") return item.status === "uncomparable" || item.status === "ambiguous";
        return true;
      })
    : [];

  // Helper to render diff inline highlights
  const renderLineContentWithInline = (line: DiffLine) => {
    if (!line.inlineChanges || line.inlineChanges.length === 0) {
      return <span>{line.content}</span>;
    }

    const elements: React.ReactNode[] = [];
    const text = line.content;
    let lastIdx = 0;

    line.inlineChanges.forEach((range, idx) => {
      // 変更箇所の前の通常テキスト
      if (range.start > lastIdx) {
        elements.push(<span key={`norm-${idx}`}>{text.substring(lastIdx, range.start)}</span>);
      }
      // 変更箇所のハイライトテキスト
      elements.push(
        <span key={`highlight-${idx}`} className="inline-change-highlight">
          {text.substring(range.start, range.end)}
        </span>
      );
      lastIdx = range.end;
    });

    // 変更箇所の後ろの残りテキスト
    if (lastIdx < text.length) {
      elements.push(<span key="norm-last">{text.substring(lastIdx)}</span>);
    }

    return <>{elements}</>;
  };

  return (
    <div className="app-container">
      {/* Premium Navigation Header */}
      <header className="app-header">
        <div className="logo-section" onClick={() => setView('home')}>
          <div className="logo-icon">⇄</div>
          <div className="logo-text">diff-bridge</div>
        </div>
        <nav className="nav-links">
          <button className={`nav-button ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}>
            ホーム
          </button>
          <button className={`nav-button ${view === 'bulk-diff' || (view === 'diff-detail' && session?.mode === 'bulk') ? 'active' : ''}`} onClick={() => { if(session) { setView('bulk-diff') } else { setView('home') } }}>
            一括比較
          </button>
          <button className={`nav-button ${view === 'history' ? 'active' : ''}`} onClick={() => { loadHistories(); setView('history'); }}>
            同期履歴
          </button>
          <button className={`nav-button ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
            設定
          </button>
        </nav>
      </header>

      {/* Main View Area */}
      <main className="app-content">
        {errorMsg && (
          <div className="warning-alert" style={{ marginBottom: '1.5rem' }}>
            <span>⚠️</span>
            <div>
              <strong>エラーが発生しました:</strong>
              <p style={{ marginTop: '0.2rem' }}>{errorMsg}</p>
            </div>
          </div>
        )}

        {/* ==================== HOME VIEW ==================== */}
        {view === 'home' && (
          <div className="home-layout">
            <div className="glass-panel">
              <h1 className="page-title">差分比較・同期アシスタント</h1>
              <p className="page-subtitle">2つのディレクトリまたはファイルを比較し、安全に同期と履歴の管理を行います。</p>
              
              <div className="mode-cards">
                <div className="mode-card" onClick={() => { setSession(null); setView('bulk-diff'); }}>
                  <div className="mode-card-icon">📁</div>
                  <h3>ディレクトリ一括比較</h3>
                  <p>同名のディレクトリを再帰的に走査し、相対パスが一致するファイルをペアリングして一括比較します。WSL2 Linux配下も対応。</p>
                  <button className="btn btn-primary" style={{ marginTop: 'auto', alignSelf: 'flex-start' }}>
                    一括比較を開始
                  </button>
                </div>

                <div className="mode-card" onClick={() => { setSession(null); setView('specified-diff'); }}>
                  <div className="mode-card-icon">📄</div>
                  <h3>任意の2ファイル比較</h3>
                  <p>ファイル名や保存場所が異なる任意のテキストファイルを2つ選択し、行単位・文字単位で差分を詳細表示します。</p>
                  <button className="btn btn-secondary" style={{ marginTop: 'auto', alignSelf: 'flex-start' }}>
                    ファイル指定比較
                  </button>
                </div>
              </div>
            </div>

            {/* Recent Sessions */}
            {recentSessions.length > 0 && (
              <div className="glass-panel recent-sessions">
                <h3 className="recent-title">⏱️ 最近使用した比較対象</h3>
                <div className="session-list">
                  {recentSessions.map((s, idx) => (
                    <div key={idx} className="session-item" onClick={() => {
                      setLeftRoot(s.leftRoot || "");
                      setRightRoot(s.rightRoot || "");
                      setSession(s);
                      setView('bulk-diff');
                    }}>
                      <div className="session-info">
                        <div className="session-paths">
                          <span>{s.leftRoot?.split(/[/\\]/).pop() || s.leftRoot}</span>
                          <span className="session-arrow">⇄</span>
                          <span>{s.rightRoot?.split(/[/\\]/).pop() || s.rightRoot}</span>
                        </div>
                        <span className="session-date">
                          比較日時: {new Date(s.createdAt).toLocaleString("ja-JP")}
                        </span>
                      </div>
                      <span className="badge badge-same">再読み込み</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ==================== BULK DIFF VIEW ==================== */}
        {view === 'bulk-diff' && (
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 className="page-title">📁 ディレクトリ一括比較</h2>
            
            <div className="compare-setup">
              <div className="path-selector-grid">
                <div className="path-box">
                  <label>左側ディレクトリ (ソースA)</label>
                  <div className="input-group">
                    <input 
                      type="text" 
                      className="input-text" 
                      placeholder="C:\path\to\directory-a" 
                      value={leftRoot}
                      onChange={(e) => setLeftRoot(e.target.value)}
                    />
                    <button className="btn btn-secondary" onClick={handleSelectLeftDir}>
                      参照...
                    </button>
                  </div>
                </div>

                <div className="path-box">
                  <label>右側ディレクトリ (ソースB)</label>
                  <div className="input-group">
                    <input 
                      type="text" 
                      className="input-text" 
                      placeholder="\\wsl$\Ubuntu\home\user\directory-b" 
                      value={rightRoot}
                      onChange={(e) => setRightRoot(e.target.value)}
                    />
                    <button className="btn btn-secondary" onClick={handleSelectRightDir}>
                      参照...
                    </button>
                  </div>
                </div>
              </div>

              {/* Options Accordion */}
              <div className="options-accordion">
                <button className="options-trigger" onClick={() => setShowOptions(!showOptions)}>
                  <span>⚙️ 比較オプション設定</span>
                  <span>{showOptions ? "▲" : "▼"}</span>
                </button>
                {showOptions && (
                  <div className="options-content">
                    <label className="checkbox-label">
                      <input 
                        type="checkbox" 
                        checked={options.useGitignore}
                        onChange={(e) => setOptions({ ...options, useGitignore: e.target.checked })}
                      />
                      .gitignore ルールを除外適用
                    </label>
                    <label className="checkbox-label">
                      <input 
                        type="checkbox" 
                        checked={options.matchRule === "fileName"}
                        onChange={(e) => setOptions({ ...options, matchRule: e.target.checked ? "fileName" : "relativePath" })}
                      />
                      ファイル名一致で照合（階層無視）
                    </label>
                    <label className="checkbox-label">
                      <input 
                        type="checkbox" 
                        checked={options.ignoreWhitespace}
                        onChange={(e) => setOptions({ ...options, ignoreWhitespace: e.target.checked })}
                      />
                      空白の変更を無視
                    </label>
                    <label className="checkbox-label">
                      <input 
                        type="checkbox" 
                        checked={options.ignoreCase}
                        onChange={(e) => setOptions({ ...options, ignoreCase: e.target.checked })}
                      />
                      大文字・小文字の変更を無視
                    </label>
                  </div>
                )}
              </div>

              <button className="btn btn-primary" onClick={handleCompareDirs} disabled={loading} style={{ alignSelf: 'flex-end', minWidth: '150px' }}>
                {loading ? "比較中..." : "📁 ディレクトリを比較"}
              </button>
            </div>

            {/* Spinner Progress Screen */}
            {loading && (
              <div className="progress-container">
                <div className="spinner"></div>
                <p style={{ color: 'var(--text-secondary)' }}>
                  ファイルを照合し、差分を抽出しています... 大量ファイルの場合は時間がかかることがあります。
                </p>
                <button 
                  className="btn btn-secondary btn-danger" 
                  onClick={async () => {
                    try {
                      await cancelCompare();
                    } catch (e) {
                      console.error(e);
                    }
                  }}
                  style={{ marginTop: '1rem', padding: '0.6rem 2rem' }}
                >
                  🛑 比較をキャンセル
                </button>
              </div>
            )}

            {/* Session comparison results list */}
            {session && !loading && (
              <div>
                <div className="results-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <div className="filter-tabs">
                      <button className={`filter-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
                        すべて ({session.results.length})
                      </button>
                      <button className={`filter-tab ${filter === 'modified' ? 'active' : ''}`} onClick={() => setFilter('modified')}>
                        変更あり ({session.results.filter(x => x.status === 'modified').length})
                      </button>
                      <button className={`filter-tab ${filter === 'leftOnly' ? 'active' : ''}`} onClick={() => setFilter('leftOnly')}>
                        左のみ ({session.results.filter(x => x.status === 'leftOnly').length})
                      </button>
                      <button className={`filter-tab ${filter === 'rightOnly' ? 'active' : ''}`} onClick={() => setFilter('rightOnly')}>
                        右のみ ({session.results.filter(x => x.status === 'rightOnly').length})
                      </button>
                      <button className={`filter-tab ${filter === 'same' ? 'active' : ''}`} onClick={() => setFilter('same')}>
                        同一 ({session.results.filter(x => x.status === 'same').length})
                      </button>
                    </div>

                    <div className="view-switch-tabs">
                      <button className={`view-switch-tab ${viewMode === 'tree' ? 'active' : ''}`} onClick={() => setViewMode('tree')}>
                        🌲 ツリー表示
                      </button>
                      <button className={`view-switch-tab ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')}>
                        📋 テーブル表示
                      </button>
                    </div>
                  </div>

                  <div className="search-box-container">
                    <span className="search-icon-placeholder">🔍</span>
                    <input 
                      type="text" 
                      className="search-input" 
                      placeholder="ファイル名で検索..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>

                {filteredResults.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-icon">📂</div>
                    <p>該当するファイルはありません。</p>
                  </div>
                ) : viewMode === 'tree' ? (
                  (() => {
                    const treeData = buildTreeData(filteredResults);
                    const flatNodes = flattenTree(treeData, expandedPaths);

                    return (
                      <div className="tree-view-container">
                        {/* Left Tree */}
                        <div className="tree-pane" ref={leftTreeRef} onScroll={handleLeftTreeScroll}>
                          <h4>左側: {session.leftRoot?.split(/[/\\]/).pop() || "左フォルダ"}</h4>
                          {flatNodes.length === 0 ? (
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>フォルダが空か、対象ファイルがありません。</p>
                          ) : (
                            flatNodes.map(node => {
                              const isRightOnly = node.status === 'rightOnly';
                              const statusClass = `tree-status-${node.status}`;
                              
                              return (
                                <div 
                                  key={`left-${node.key}`} 
                                  className={`tree-item ${node.type === 'folder' ? 'tree-item-folder' : 'tree-item-file'} ${statusClass}`}
                                  style={{ paddingLeft: `${node.depth * 1.2 + 0.6}rem`, opacity: isRightOnly ? 0.35 : 1 }}
                                  onClick={() => {
                                    if (node.type === 'folder') {
                                      togglePath(node.relativePath);
                                    } else if (!isRightOnly && node.fileResult) {
                                      handleShowFileDiff(node.fileResult);
                                    }
                                  }}
                                >
                                  {node.type === 'folder' ? (
                                    <>
                                      <span className="tree-toggle-icon">
                                        {expandedPaths.includes(node.relativePath) ? "▼" : "▶"}
                                      </span>
                                      <span>{expandedPaths.includes(node.relativePath) ? "📂" : "📁"}</span>
                                    </>
                                  ) : (
                                    <span>📄</span>
                                  )}
                                  <span className="tree-item-name">{node.name}</span>
                                  {node.type === 'file' && (
                                    <span className="tree-item-badge">
                                      {node.status === 'same' && ""}
                                      {node.status === 'modified' && "変更"}
                                      {node.status === 'leftOnly' && "新規(L)"}
                                      {node.status === 'rightOnly' && "欠落"}
                                      {node.status === 'uncomparable' && "対象外"}
                                      {node.status === 'ambiguous' && "重複"}
                                    </span>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>

                        {/* Right Tree */}
                        <div className="tree-pane" ref={rightTreeRef} onScroll={handleRightTreeScroll}>
                          <h4>右側: {session.rightRoot?.split(/[/\\]/).pop() || "右フォルダ"}</h4>
                          {flatNodes.length === 0 ? (
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>フォルダが空か、対象ファイルがありません。</p>
                          ) : (
                            flatNodes.map(node => {
                              const isLeftOnly = node.status === 'leftOnly';
                              const statusClass = `tree-status-${node.status}`;
                              
                              return (
                                <div 
                                  key={`right-${node.key}`} 
                                  className={`tree-item ${node.type === 'folder' ? 'tree-item-folder' : 'tree-item-file'} ${statusClass}`}
                                  style={{ paddingLeft: `${node.depth * 1.2 + 0.6}rem`, opacity: isLeftOnly ? 0.35 : 1 }}
                                  onClick={() => {
                                    if (node.type === 'folder') {
                                      togglePath(node.relativePath);
                                    } else if (!isLeftOnly && node.fileResult) {
                                      handleShowFileDiff(node.fileResult);
                                    }
                                  }}
                                >
                                  {node.type === 'folder' ? (
                                    <>
                                      <span className="tree-toggle-icon">
                                        {expandedPaths.includes(node.relativePath) ? "▼" : "▶"}
                                      </span>
                                      <span>{expandedPaths.includes(node.relativePath) ? "📂" : "📁"}</span>
                                    </>
                                  ) : (
                                    <span>📄</span>
                                  )}
                                  <span className="tree-item-name">{node.name}</span>
                                  {node.type === 'file' && (
                                    <span className="tree-item-badge">
                                      {node.status === 'same' && ""}
                                      {node.status === 'modified' && "変更"}
                                      {node.status === 'leftOnly' && "欠落"}
                                      {node.status === 'rightOnly' && "新規(R)"}
                                      {node.status === 'uncomparable' && "対象外"}
                                      {node.status === 'ambiguous' && "重複"}
                                    </span>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="table-wrapper">
                    <table className="results-table">
                      <thead>
                        <tr>
                          <th>ファイル名 / 相対パス</th>
                          <th>状態</th>
                          <th>変更行数</th>
                          <th>左側サイズ</th>
                          <th>右側サイズ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredResults.map((item) => (
                          <tr key={item.id} onClick={() => handleShowFileDiff(item)}>
                            <td style={{ fontWeight: '500' }}>
                              <div>{item.fileName}</div>
                              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                                {item.relativePath || "/"}
                              </div>
                            </td>
                            <td>
                              {item.status === 'same' && <span className="badge badge-same">同一</span>}
                              {item.status === 'modified' && <span className="badge badge-modified">変更あり</span>}
                              {item.status === 'leftOnly' && <span className="badge badge-left-only">左のみ</span>}
                              {item.status === 'rightOnly' && <span className="badge badge-right-only">右のみ</span>}
                              {item.status === 'uncomparable' && <span className="badge badge-uncomparable">比較不可</span>}
                              {item.status === 'ambiguous' && <span className="badge badge-ambiguous">重複曖昧</span>}
                            </td>
                            <td>
                              {item.status === 'modified' && (
                                <div className="diff-lines-summary">
                                  <span className="lines-added">+{item.addedLines}</span>
                                  <span className="lines-deleted">-{item.deletedLines}</span>
                                </div>
                              )}
                              {(item.status === 'leftOnly' || item.status === 'rightOnly') && (
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>新規作成対象</span>
                              )}
                              {item.status === 'same' && <span style={{ color: 'var(--text-muted)' }}>-</span>}
                            </td>
                            <td style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                              {item.leftSize !== undefined ? `${(item.leftSize / 1024).toFixed(1)} KB` : "-"}
                            </td>
                            <td style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                              {item.rightSize !== undefined ? `${(item.rightSize / 1024).toFixed(1)} KB` : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ==================== SPECIFIED DIFF VIEW ==================== */}
        {view === 'specified-diff' && (
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 className="page-title">📄 任意の2ファイル比較</h2>
            <p className="page-subtitle">ファイル名や配置ディレクトリ階層が異なる2つのテキストファイルを個別に比較します。</p>

            <div className="compare-setup">
              <div className="path-selector-grid">
                <div className="path-box">
                  <label>左側ファイル (比較対象A)</label>
                  <div className="input-group">
                    <input 
                      type="text" 
                      className="input-text" 
                      placeholder="C:\path\to\file-a.txt" 
                      value={leftFile}
                      onChange={(e) => setLeftFile(e.target.value)}
                    />
                    <button className="btn btn-secondary" onClick={handleSelectLeftFile}>
                      参照...
                    </button>
                  </div>
                </div>

                <div className="path-box">
                  <label>右側ファイル (比較対象B)</label>
                  <div className="input-group">
                    <input 
                      type="text" 
                      className="input-text" 
                      placeholder="C:\path\to\file-b.txt" 
                      value={rightFile}
                      onChange={(e) => setRightFile(e.target.value)}
                    />
                    <button className="btn btn-secondary" onClick={handleSelectRightFile}>
                      参照...
                    </button>
                  </div>
                </div>
              </div>

              {/* Options */}
              <div className="options-accordion">
                <button className="options-trigger" onClick={() => setShowOptions(!showOptions)}>
                  <span>⚙️ 比較オプション設定</span>
                  <span>{showOptions ? "▲" : "▼"}</span>
                </button>
                {showOptions && (
                  <div className="options-content" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                    <label className="checkbox-label">
                      <input 
                        type="checkbox" 
                        checked={options.ignoreWhitespace}
                        onChange={(e) => setOptions({ ...options, ignoreWhitespace: e.target.checked })}
                      />
                      空白の変更を無視
                    </label>
                    <label className="checkbox-label">
                      <input 
                        type="checkbox" 
                        checked={options.ignoreCase}
                        onChange={(e) => setOptions({ ...options, ignoreCase: e.target.checked })}
                      />
                      大文字・小文字の変更を無視
                    </label>
                  </div>
                )}
              </div>

              <button className="btn btn-primary" onClick={handleCompareFiles} disabled={loading} style={{ alignSelf: 'flex-end', minWidth: '150px' }}>
                {loading ? "比較中..." : "📄 ファイルを比較"}
              </button>
            </div>
          </div>
        )}

        {/* ==================== DIFF DETAIL VIEW (2 PANE) ==================== */}
        {view === 'diff-detail' && activeFileResult && activeDiffDetail && (
          <div className="detail-layout">
            <div className="detail-actions-bar">
              <div className="detail-path-title">
                <span>比較ファイル: {activeFileResult.fileName}</span>
                <h3>
                  {activeFileResult.relativePath || activeFileResult.fileName}
                </h3>
              </div>

              <div className="sync-action-buttons">
                {/* 左から右への同期 */}
                {activeFileResult.status !== 'same' && (
                  <button 
                    className="btn btn-primary"
                    onClick={() => {
                      setSyncDirection("leftToRight");
                      setShowSyncConfirm(true);
                    }}
                  >
                    ◀ 左の内容を右へ適用 (同期)
                  </button>
                )}

                {/* 右から左への同期 */}
                {activeFileResult.status !== 'same' && (
                  <button 
                    className="btn btn-secondary"
                    onClick={() => {
                      setSyncDirection("rightToLeft");
                      setShowSyncConfirm(true);
                    }}
                  >
                    右の内容を左へ適用 (同期) ▶
                  </button>
                )}

                <button className="btn btn-secondary" onClick={() => {
                  if (session) {
                    setView('bulk-diff');
                  } else {
                    setView('home');
                  }
                }}>
                  戻る
                </button>
              </div>
            </div>

            {/* Side-by-side synchronized scrolling viewer */}
            <div className="two-pane-container">
              {/* Left Pane (A) */}
              <div className="pane" ref={leftPaneRef} onScroll={handleLeftScroll}>
                <div className="pane-header">
                  <span>左側ファイル</span>
                  <span>{activeDiffDetail.leftPath}</span>
                </div>
                <div className="pane-code-area">
                  {activeDiffDetail.lines.map((line, idx) => {
                    const isRightOnly = line.leftLineNo === null;
                    if (isRightOnly) {
                      return <div key={idx} className="code-line empty-stub"><div className="line-number">-</div><div className="line-content"></div></div>;
                    }

                    // CSS クラス判定
                    let lineClass = "equal";
                    if (line.tag === "delete" || line.tag === "modify-delete") lineClass = "delete";

                    return (
                      <div key={idx} className={`code-line ${lineClass}`}>
                        <div className="line-number">{line.leftLineNo}</div>
                        <div className="line-content">{renderLineContentWithInline(line)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right Pane (B) */}
              <div className="pane" ref={rightPaneRef} onScroll={handleRightScroll}>
                <div className="pane-header">
                  <span>右側ファイル</span>
                  <span>{activeDiffDetail.rightPath}</span>
                </div>
                <div className="pane-code-area">
                  {activeDiffDetail.lines.map((line, idx) => {
                    const isLeftOnly = line.rightLineNo === null;
                    if (isLeftOnly) {
                      return <div key={idx} className="code-line empty-stub"><div className="line-number">-</div><div className="line-content"></div></div>;
                    }

                    let lineClass = "equal";
                    if (line.tag === "insert" || line.tag === "modify-insert") lineClass = "insert";

                    return (
                      <div key={idx} className={`code-line ${lineClass}`}>
                        <div className="line-number">{line.rightLineNo}</div>
                        <div className="line-content">{renderLineContentWithInline(line)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== HISTORY VIEW ==================== */}
        {view === 'history' && (
          <div className="glass-panel">
            <h2 className="page-title">⏱️ 同期履歴・復元</h2>
            <p className="page-subtitle">これまでの同期操作（ファイル上書き・新規作成）の全履歴です。Gitコミットに基づいて安全に復旧できます。</p>

            {historyLoading ? (
              <div className="progress-container">
                <div className="spinner"></div>
                <p>同期履歴を読み込んでいます...</p>
              </div>
            ) : histories.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">⏱️</div>
                <p>同期操作の履歴はまだ存在しません。</p>
              </div>
            ) : (
              <div className="history-timeline">
                {histories.map((h) => (
                  <div key={h.id} className={`history-node ${h.status}`}>
                    <div className="history-node-header">
                      <div className="history-meta-top">
                        <span className="history-action-text">
                          {h.status === "restored" ? "↩️ 復元操作完了" : "⇄ ファイル単位同期"}
                        </span>
                        <span className="history-time">
                          {new Date(h.createdAt).toLocaleString("ja-JP")}
                        </span>
                      </div>
                      
                      {h.status === "success" && (
                        <button 
                          className="btn btn-secondary btn-danger" 
                          style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                          onClick={() => handleRestore(h.id)}
                        >
                          ↩️ この同期を元に戻す (復元)
                        </button>
                      )}

                      {h.status === "restored" && (
                        <span className="badge badge-same" style={{ background: 'rgba(139, 92, 246, 0.2)', color: '#c084fc' }}>
                          復元済み
                        </span>
                      )}
                    </div>

                    <div className="history-node-body">
                      <div className="history-path-info">
                        <label>同期方向:</label>
                        <span>{h.direction === "leftToRight" ? "左 ➔ 右 (上書き・作成)" : "右 ➔ 左 (上書き・作成)"}</span>
                      </div>
                      <div className="history-path-info">
                        <label>同期元:</label>
                        <span>{h.sourcePath}</span>
                      </div>
                      <div className="history-path-info">
                        <label>同期先:</label>
                        <span>{h.targetPath}</span>
                      </div>
                      <div className="history-commit-badge">
                        Commit ID: {h.commitId.substring(0, 10)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ==================== SETTINGS VIEW ==================== */}
        {view === 'settings' && (
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 className="page-title">⚙️ システム設定</h2>
            <p className="page-subtitle">アプリケーションの基本動作パラメータを設定します。</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem', maxWidth: '600px' }}>
              <div className="path-box">
                <label>大容量ファイル警告の閾値 (MB)</label>
                <input 
                  type="number" 
                  className="input-text" 
                  value={options.maxWarnFileSizeMb}
                  onChange={(e) => setOptions({ ...options, maxWarnFileSizeMb: parseFloat(e.target.value) || 10 })}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  このサイズを超えるファイルを比較する場合、パフォーマンス低下を防ぐために警告を表示します。
                </span>
              </div>

              <div className="path-box">
                <label>最大比較可能ファイルサイズの閾値 (MB)</label>
                <input 
                  type="number" 
                  className="input-text" 
                  value={options.maxComparableFileSizeMb}
                  onChange={(e) => setOptions({ ...options, maxComparableFileSizeMb: parseFloat(e.target.value) || 100 })}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  このサイズを超える大容量ファイルは、クラッシュ回避のため初期設定で比較対象外とします。
                </span>
              </div>

              <div className="path-box">
                <label>履歴管理の保存方針</label>
                <input 
                  type="text" 
                  className="input-text" 
                  value="アプリ専用Git管理領域（ローカルAppData保存）" 
                  disabled 
                  style={{ opacity: 0.7 }}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  同期操作はアプリデータ領域内のGitリポジトリへ安全にバックアップされ、既存プロジェクトのGit履歴を汚しません。
                </span>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ==================== SYNC CONFIRMATION DIALOG ==================== */}
      {showSyncConfirm && activeFileResult && syncDirection && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>⚡ 同期の最終確認</h3>
            </div>
            
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                選択したファイルの中身を完全に上書き、あるいは新規作成します。同期の方向と対象ファイルを十分にご確認ください。
              </p>

              <div className="sync-confirm-flow">
                <div className="sync-flow-node">
                  <span>同期元 (コピー元)</span>
                  <p>{syncDirection === 'leftToRight' ? activeFileResult.leftPath : activeFileResult.rightPath}</p>
                </div>
                <div className="sync-flow-arrow">➔</div>
                <div className="sync-flow-node">
                  <span>同期先 (上書き先)</span>
                  <p>
                    {syncDirection === 'leftToRight' 
                      ? (activeFileResult.rightPath || `${session?.rightRoot}/${activeFileResult.relativePath}`)
                      : (activeFileResult.leftPath || `${session?.leftRoot}/${activeFileResult.relativePath}`)
                    }
                  </p>
                </div>
              </div>

              <div className="warning-alert">
                <span>⚠️</span>
                <div>
                  <strong>破壊的操作の警告:</strong>
                  <p style={{ marginTop: '0.2rem' }}>
                    この操作は上書き・新規作成を伴います。同期を実行すると、同期先ファイルの既存のデータは失われます。
                  </p>
                  <p style={{ marginTop: '0.4rem', color: 'var(--text-primary)', fontWeight: '500' }}>
                    ※ 同期前後の状態はアプリの専用Git履歴に保存されるため、後から「同期履歴」画面より元に戻すことが可能です。
                  </p>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSyncConfirm(false)} disabled={syncing}>
                キャンセル
              </button>
              <button className="btn btn-primary" onClick={handleExecuteSync} disabled={syncing}>
                {syncing ? "同期を実行中..." : "確認して同期を実行"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
