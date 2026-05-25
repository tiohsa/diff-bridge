import React, { useState, useEffect, useRef } from "react";
import {
  selectDirectory,
  selectFile,
  compareDirectories,
  compareFiles,
  syncFile,
  syncFolder,
  getSyncHistories,
  restoreSync,
  cancelCompare
} from "./api";
import { CompareSession, DiffFileResult, DiffOptions, FileDiffDetail, SyncFolderEntry, SyncHistory, DiffLine } from "./types";
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

interface FolderSyncPlan {
  relativePath: string;
  folderName: string;
  direction: 'leftToRight' | 'rightToLeft';
  sourcePath: string;
  targetPath: string;
  entries: SyncFolderEntry[];
  skippedCount: number;
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

const RadialSpikeIcon = ({ size = 20, className = "", style = {} }: { size?: number, className?: string, style?: React.CSSProperties }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="currentColor" 
    className={`radial-spike ${className}`}
    style={style}
  >
    <path d="M12 2C12.5523 2 13 6.44772 13 12C13 17.5523 12.5523 22 12 22C11.4477 22 11 17.5523 11 12C11 6.44772 11.4477 2 12 2Z" />
    <path d="M2 12C2 11.4477 6.44772 11 12 11C17.5523 11 22 11.4477 22 12C22 12.5523 17.5523 13 12 13C6.44772 13 2 12.5523 2 12Z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);


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

const joinPath = (root: string, relativePath: string) => {
  if (!relativePath) return root;
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const normalizedRelative = relativePath.replace(/^[\\/]+/, "");
  return `${normalizedRoot}/${normalizedRelative}`;
};

export default function App() {
  // Navigation State
  const [view, setView] = useState<'home' | 'bulk-diff' | 'specified-diff' | 'history' | 'settings'>('home');

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
  const [folderSyncPlan, setFolderSyncPlan] = useState<FolderSyncPlan | null>(null);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Histories State
  const [histories, setHistories] = useState<SyncHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);

  // Specific file history modal state
  const [historyFileResult, setHistoryFileResult] = useState<DiffFileResult | null>(null);

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

  const handleExpandAll = () => {
    if (!session) return;
    const paths = Array.from(new Set(session.results.map(r => {
      const parts = (r.relativePath || r.fileName).split('/');
      const folders = [];
      for (let i = 0; i < parts.length - 1; i++) {
        folders.push(parts.slice(0, i + 1).join('/'));
      }
      return folders;
    }).flat()));
    setExpandedPaths(paths);
  };

  const handleCollapseAll = () => {
    setExpandedPaths([]);
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
    } catch (e: any) {
      setErrorMsg(e.toString());
    }
  };

  const buildFolderSyncPlan = (
    relativePath: string,
    folderName: string,
    direction: 'leftToRight' | 'rightToLeft'
  ): FolderSyncPlan | null => {
    if (!session?.leftRoot || !session?.rightRoot) return null;

    const entries: SyncFolderEntry[] = [];
    let skippedCount = 0;
    const isLeftToRight = direction === "leftToRight";

    session.results.forEach((result) => {
      const resultRelative = result.relativePath || result.fileName;
      const isInsideFolder = resultRelative === relativePath || resultRelative.startsWith(`${relativePath}/`);
      if (!isInsideFolder || result.status === "same") return;

      const sourcePath = isLeftToRight ? result.leftPath : result.rightPath;
      const targetPath = isLeftToRight
        ? (result.rightPath || joinPath(session.rightRoot!, resultRelative))
        : (result.leftPath || joinPath(session.leftRoot!, resultRelative));
      const beforeHash = isLeftToRight ? (result.rightHash || "") : (result.leftHash || "");
      const entryRelativePath = resultRelative.startsWith(`${relativePath}/`)
        ? resultRelative.slice(relativePath.length + 1)
        : result.fileName;

      if (!sourcePath) {
        skippedCount += 1;
        return;
      }

      entries.push({
        sourcePath,
        targetPath,
        relativePath: entryRelativePath,
        beforeHash,
      });
    });

    return {
      relativePath,
      folderName,
      direction,
      sourcePath: joinPath(isLeftToRight ? session.leftRoot : session.rightRoot, relativePath),
      targetPath: joinPath(isLeftToRight ? session.rightRoot : session.leftRoot, relativePath),
      entries,
      skippedCount,
    };
  };

  const handlePrepareFolderSync = (
    node: FlatTreeNode,
    direction: 'leftToRight' | 'rightToLeft',
    event: React.MouseEvent
  ) => {
    event.stopPropagation();
    const plan = buildFolderSyncPlan(node.relativePath, node.name, direction);
    if (!plan || plan.entries.length === 0) {
      alert("このフォルダには、指定方向に反映できる差分ファイルがありません。");
      return;
    }
    setFolderSyncPlan(plan);
  };

  const handleExecuteFolderSync = async () => {
    if (!folderSyncPlan) return;
    setSyncing(true);
    setErrorMsg(null);
    try {
      await syncFolder(
        session?.id || "manual-folder-sync",
        session?.mode || "bulk",
        folderSyncPlan.direction,
        folderSyncPlan.sourcePath,
        folderSyncPlan.targetPath,
        folderSyncPlan.entries
      );

      setFolderSyncPlan(null);
      alert("フォルダ同期が完了しました。履歴にGitコミットとして保存されました。");

      if (session && session.leftRoot && session.rightRoot) {
        await handleCompareDirs();
      }
      loadHistories();
    } catch (e: any) {
      setErrorMsg(e.toString());
      alert(`フォルダ同期エラー: ${e.toString()}`);
    } finally {
      setSyncing(false);
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
      
      // 詳細ダイアログを閉じる
      setActiveFileResult(null);
      setActiveDiffDetail(null);
      
      // 同期完了後のリフレッシュ
      if (session && session.leftRoot && session.rightRoot) {
        // 一括diffモードなら再度比較を走らせてリスト更新
        await handleCompareDirs();
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

  // 特定のファイルに関連する同期履歴を抽出する
  const getFileHistories = (fileResult: DiffFileResult) => {
    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    return histories.filter(h => {
      const hSource = normalize(h.sourcePath);
      const hTarget = normalize(h.targetPath);
      const fLeft = fileResult.leftPath ? normalize(fileResult.leftPath) : '';
      const fRight = fileResult.rightPath ? normalize(fileResult.rightPath) : '';
      
      // 絶対パス完全一致
      const matchAbsolute = (fLeft && (hSource === fLeft || hTarget === fLeft)) ||
                            (fRight && (hSource === fRight || hTarget === fRight));
                            
      // 相対パス一致（末尾が相対パス）
      const matchRelative = fileResult.relativePath && (
        hSource.endsWith(normalize(fileResult.relativePath)) ||
        hTarget.endsWith(normalize(fileResult.relativePath))
      );
      
      // ファイル名一致
      const matchFileName = !fileResult.relativePath && (
        normalize(h.targetPath).endsWith('/' + normalize(fileResult.fileName)) ||
        normalize(h.sourcePath).endsWith('/' + normalize(fileResult.fileName))
      );
      
      return matchAbsolute || matchRelative || matchFileName;
    });
  };

  // 特定ファイル用の復元ハンドラー
  const handleRestoreFileHistory = async (historyId: string) => {
    if (!confirm("本当にこのファイルの同期操作を元に戻しますか？")) return;
    setErrorMsg(null);
    try {
      await restoreSync(historyId);
      alert("復元に成功しました。復元操作も履歴に保存されました。");
      
      // 履歴をリロード
      await loadHistories();
      
      // 現在開いている比較結果を自動で再スキャン・リフレッシュ
      if (session && session.leftRoot && session.rightRoot) {
        await handleCompareDirs();
      } else if (leftFile && rightFile) {
        await handleCompareFiles();
      }
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
          <div className="logo-icon" style={{ background: 'transparent', color: 'var(--color-primary)', width: 'auto', height: 'auto' }}>
            <RadialSpikeIcon size={26} />
          </div>
          <div className="logo-text">diff-bridge</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <nav className="nav-links">
            <button className={`nav-button ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}>
              ホーム
            </button>
            <button className={`nav-button ${view === 'bulk-diff' ? 'active' : ''}`} onClick={() => setView('bulk-diff')}>
              一括比較
            </button>
            <button className={`nav-button ${view === 'history' ? 'active' : ''}`} onClick={() => { loadHistories(); setView('history'); }}>
              同期履歴
            </button>
            <button className={`nav-button ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
              設定
            </button>
          </nav>
          {view !== 'bulk-diff' && (
            <button className="btn btn-primary" style={{ padding: '0.45rem 1.1rem', fontSize: '0.82rem', height: '36px' }} onClick={() => { setSession(null); setView('bulk-diff'); }}>
              新規比較
            </button>
          )}
        </div>
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
            <div className="home-hero">
              <h1 className="title-with-spike" style={{ justifyContent: 'center' }}>
                <RadialSpikeIcon size={34} style={{ color: 'var(--color-primary)' }} />
                <span>差分比較・同期アシスタント</span>
              </h1>
              <p>2つのディレクトリまたはファイルを精密に比較し、安全に同期と履歴の管理を行います。</p>
            </div>
              
            <div className="mode-cards">
              <div className="mode-card" onClick={() => { setSession(null); setView('bulk-diff'); }}>
                <div className="mode-card-icon">📁</div>
                <h3>ディレクトリ一括比較</h3>
                <p>同名のディレクトリを再帰的に走査し、相対パスが一致するファイルをペアリングして一括比較します。WSL2 Linux配下も完全対応。</p>
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

            {/* Recent Sessions */}
            {recentSessions.length > 0 && (
              <div className="setup-card recent-sessions" style={{ marginTop: '1rem' }}>
                <h3 className="recent-title title-with-spike">
                  <RadialSpikeIcon size={18} />
                  <span>最近使用した比較対象</span>
                </h3>
                <div className="session-list" style={{ marginTop: '1rem' }}>
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

            {/* Showcase Dark Product Card (Cream-to-Dark rhythm) */}
            <div className="product-mockup-card-dark">
              <h3>
                <RadialSpikeIcon size={22} />
                <span>超高速・高性能なコード同期エンジン</span>
              </h3>
              <p>
                diff-bridge は Tauri バックエンドで Rust をフル活用し、数万ファイルにおよぶディレクトリ同士でもハッシュ計算によってミリ秒単位で差分を検出します。同期操作はアプリ内の専用 Git 管理下で自動コミットされるため、ワンクリックでいつでも復元可能です。
              </p>
              
              <div className="code-window-card">
                <div className="code-window-line">
                  <span className="code-window-ln">1</span>
                  <span className="code-window-text"><span className="highlight-teal">fn</span> <span className="highlight-green">compare_files</span>(left: &amp;Path, right: &amp;Path) -&gt; Result&lt;Diff, Error&gt; &#123;</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">2</span>
                  <span className="code-window-text">    <span className="highlight-teal">let</span> left_hash = <span className="highlight-green">hash_file</span>(left)?;</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">3</span>
                  <span className="code-window-text">    <span className="highlight-teal">let</span> right_hash = <span className="highlight-green">hash_file</span>(right)?;</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">4</span>
                  <span className="code-window-text">    <span className="highlight-coral">if</span> left_hash == right_hash &#123;</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">5</span>
                  <span className="code-window-text highlight-green">        Ok(Diff::Same)</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">6</span>
                  <span className="code-window-text">    &#125; <span className="highlight-coral">else</span> &#123;</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">7</span>
                  <span className="code-window-text highlight-coral">        Ok(Diff::Modified)</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">8</span>
                  <span className="code-window-text">    &#125;</span>
                </div>
                <div className="code-window-line">
                  <span className="code-window-ln">9</span>
                  <span className="code-window-text">&#125;</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== BULK DIFF VIEW ==================== */}
        {view === 'bulk-diff' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 className="page-title title-with-spike">
              <RadialSpikeIcon size={24} />
              <span>ディレクトリ一括比較</span>
            </h2>
            
            <div className="setup-card">
              <h3 className="setup-card-title">比較対象ディレクトリの指定</h3>
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
                  {loading ? "比較中..." : "ディレクトリを比較 ➔"}
                </button>
              </div>
            </div>

            {/* Spinner Progress Screen */}
            {loading && (
              <div className="setup-card progress-container" style={{ background: 'var(--color-surface-soft)' }}>
                <div className="spinner"></div>
                <p style={{ color: 'var(--color-muted)', fontSize: '0.95rem' }}>
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
              <div className="results-section">
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

                    {viewMode === 'tree' && (
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button className="tree-control-btn expand" onClick={handleExpandAll}>
                          👐 すべて展開
                        </button>
                        <button className="tree-control-btn collapse" onClick={handleCollapseAll}>
                          🤝 すべて閉じる
                        </button>
                      </div>
                    )}
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
                  <div className="setup-card empty-state" style={{ background: 'var(--color-surface-soft)' }}>
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
                            <p style={{ color: 'var(--color-on-dark-soft)', fontSize: '0.9rem' }}>フォルダが空か、対象ファイルがありません。</p>
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
                                  {node.type === 'folder' && node.status !== 'same' && node.status !== 'rightOnly' && (
                                    <button
                                      className="tree-item-history-btn"
                                      title="このフォルダ配下の差分を右側へ反映"
                                      onClick={(e) => handlePrepareFolderSync(node, "leftToRight", e)}
                                    >
                                      右へ
                                    </button>
                                  )}
                                  {node.type === 'file' && (
                                    <>
                                      {node.fileResult && (
                                        <button 
                                          className="tree-item-history-btn"
                                          title="このファイルの同期履歴を表示"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setHistoryFileResult(node.fileResult!);
                                          }}
                                        >
                                          ⏱️
                                        </button>
                                      )}
                                      <span className="tree-item-badge">
                                        {node.status === 'same' && ""}
                                        {node.status === 'modified' && "変更"}
                                        {node.status === 'leftOnly' && "新規(L)"}
                                        {node.status === 'rightOnly' && "欠落"}
                                        {node.status === 'uncomparable' && "対象外"}
                                        {node.status === 'ambiguous' && "重複"}
                                      </span>
                                    </>
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
                            <p style={{ color: 'var(--color-on-dark-soft)', fontSize: '0.9rem' }}>フォルダが空か、対象ファイルがありません。</p>
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
                                  {node.type === 'folder' && node.status !== 'same' && node.status !== 'leftOnly' && (
                                    <button
                                      className="tree-item-history-btn"
                                      title="このフォルダ配下の差分を左側へ反映"
                                      onClick={(e) => handlePrepareFolderSync(node, "rightToLeft", e)}
                                    >
                                      左へ
                                    </button>
                                  )}
                                  {node.type === 'file' && (
                                    <>
                                      {node.fileResult && (
                                        <button 
                                          className="tree-item-history-btn"
                                          title="このファイルの同期履歴を表示"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setHistoryFileResult(node.fileResult!);
                                          }}
                                        >
                                          ⏱️
                                        </button>
                                      )}
                                      <span className="tree-item-badge">
                                        {node.status === 'same' && ""}
                                        {node.status === 'modified' && "変更"}
                                        {node.status === 'leftOnly' && "欠落"}
                                        {node.status === 'rightOnly' && "新規(R)"}
                                        {node.status === 'uncomparable' && "対象外"}
                                        {node.status === 'ambiguous' && "重複"}
                                      </span>
                                    </>
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
                              <div style={{ fontSize: '0.8rem', color: 'var(--color-muted)', marginTop: '0.2rem' }}>
                                {item.relativePath || "/"}
                              </div>
                            </td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                                <div>
                                  {item.status === 'same' && <span className="badge badge-same">同一</span>}
                                  {item.status === 'modified' && <span className="badge badge-modified">変更あり</span>}
                                  {item.status === 'leftOnly' && <span className="badge badge-left-only">左のみ</span>}
                                  {item.status === 'rightOnly' && <span className="badge badge-right-only">右のみ</span>}
                                  {item.status === 'uncomparable' && <span className="badge badge-uncomparable">比較不可</span>}
                                  {item.status === 'ambiguous' && <span className="badge badge-ambiguous">重複曖昧</span>}
                                </div>
                                <button 
                                  className="table-item-history-btn"
                                  title="このファイルの同期履歴を表示"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setHistoryFileResult(item);
                                  }}
                                >
                                  ⏱️ 履歴
                                </button>
                              </div>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 className="page-title title-with-spike">
              <RadialSpikeIcon size={24} />
              <span>任意の2ファイル比較</span>
            </h2>
            <p className="page-subtitle" style={{ marginBottom: '0.5rem' }}>ファイル名や配置ディレクトリ階層が異なる2つのテキストファイルを個別に比較します。</p>

            <div className="setup-card">
              <h3 className="setup-card-title">比較対象ファイルの指定</h3>
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
                {loading ? "比較中..." : "ファイルを比較 ➔"}
              </button>
            </div>
          </div>
        </div>
      )}



        {/* ==================== HISTORY VIEW ==================== */}
        {view === 'history' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 className="page-title title-with-spike">
              <RadialSpikeIcon size={24} />
              <span>同期履歴・復元</span>
            </h2>
            <p className="page-subtitle" style={{ marginBottom: '0.5rem' }}>これまでの同期操作（ファイル上書き・新規作成）の全履歴です。Gitコミットに基づいて安全に復旧できます。</p>

            {historyLoading ? (
              <div className="setup-card progress-container" style={{ background: 'var(--color-surface-soft)' }}>
                <div className="spinner"></div>
                <p>同期履歴を読み込んでいます...</p>
              </div>
            ) : histories.length === 0 ? (
              <div className="setup-card empty-state" style={{ background: 'var(--color-surface-soft)' }}>
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
                          {h.status === "restored"
                            ? "↩️ 復元操作完了"
                            : h.syncType === "folder"
                              ? "⇄ フォルダ単位同期"
                              : "⇄ ファイル単位同期"}
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
                        <label>同期単位:</label>
                        <span>{h.syncType === "folder" ? "フォルダ" : "ファイル"}</span>
                      </div>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 className="page-title title-with-spike">
              <RadialSpikeIcon size={24} />
              <span>システム設定</span>
            </h2>
            <p className="page-subtitle" style={{ marginBottom: '0.5rem' }}>アプリケーションの基本動作パラメータを設定します。</p>

            <div className="setup-card" style={{ maxWidth: '700px' }}>
              <h3 className="setup-card-title">動作パラメータ設定</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <div className="path-box">
                  <label>大容量ファイル警告の閾値 (MB)</label>
                  <input 
                    type="number" 
                    className="input-text" 
                    value={options.maxWarnFileSizeMb}
                    onChange={(e) => setOptions({ ...options, maxWarnFileSizeMb: parseFloat(e.target.value) || 10 })}
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-muted)' }}>
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
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-muted)' }}>
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
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-muted)' }}>
                    同期操作はアプリデータ領域内のGitリポジトリへ安全にバックアップされ、既存プロジェクトのGit履歴を汚しません。
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ==================== DIFF DETAIL DIALOG ==================== */}
      {activeFileResult && activeDiffDetail && (
        <div className="modal-overlay modal-diff-overlay">
          <div className="modal-content modal-diff-detail">
            <div className="modal-header">
              <div className="detail-path-title">
                <span>比較ファイル: {activeFileResult.fileName}</span>
                <h3>{activeFileResult.relativePath || activeFileResult.fileName}</h3>
              </div>
              <button 
                className="btn btn-secondary btn-icon" 
                onClick={() => {
                  setActiveFileResult(null);
                  setActiveDiffDetail(null);
                }}
                style={{ fontSize: '1.2rem', padding: '0.2rem 0.6rem' }}
                title="閉じる"
              >
                ✕
              </button>
            </div>
            
            <div className="modal-body">
              <div className="detail-actions-bar" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--glass-border)', padding: '0.8rem 1.2rem', borderRadius: '0.6rem' }}>
                <div className="sync-action-buttons" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.8rem' }}>
                  <div style={{ display: 'flex', gap: '0.8rem' }}>
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
                  </div>

                  <button className="btn btn-secondary" onClick={() => {
                    setActiveFileResult(null);
                    setActiveDiffDetail(null);
                  }}>
                    閉じる
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
          </div>
        </div>
      )}

      {/* ==================== SYNC CONFIRMATION DIALOG ==================== */}
      {showSyncConfirm && activeFileResult && syncDirection && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="title-with-spike">
                <RadialSpikeIcon size={22} style={{ color: 'var(--color-primary)' }} />
                <span>同期の最終確認</span>
              </h3>
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

      {/* ==================== FOLDER SYNC CONFIRMATION DIALOG ==================== */}
      {folderSyncPlan && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="title-with-spike">
                <RadialSpikeIcon size={22} style={{ color: 'var(--color-primary)' }} />
                <span>フォルダ同期の最終確認</span>
              </h3>
            </div>

            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                選択したフォルダ配下の差分ファイルをまとめて上書き、または新規作成します。同期先だけに存在するファイルは削除しません。
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.8rem', margin: '1rem 0' }}>
                <div className="sync-flow-node">
                  <span>対象フォルダ</span>
                  <p>{folderSyncPlan.relativePath}</p>
                </div>
                <div className="sync-flow-node">
                  <span>反映ファイル数</span>
                  <p>{folderSyncPlan.entries.length} 件</p>
                </div>
                <div className="sync-flow-node">
                  <span>スキップ</span>
                  <p>{folderSyncPlan.skippedCount} 件</p>
                </div>
              </div>

              <div className="sync-confirm-flow">
                <div className="sync-flow-node">
                  <span>同期元フォルダ</span>
                  <p>{folderSyncPlan.sourcePath}</p>
                </div>
                <div className="sync-flow-arrow">➔</div>
                <div className="sync-flow-node">
                  <span>同期先フォルダ</span>
                  <p>{folderSyncPlan.targetPath}</p>
                </div>
              </div>

              <div className="warning-alert">
                <span>⚠️</span>
                <div>
                  <strong>破壊的操作の警告:</strong>
                  <p style={{ marginTop: '0.2rem' }}>
                    同期対象ファイルの既存データは上書きされます。同期前後の状態はアプリの専用Git履歴に保存されます。
                  </p>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setFolderSyncPlan(null)} disabled={syncing}>
                キャンセル
              </button>
              <button className="btn btn-primary" onClick={handleExecuteFolderSync} disabled={syncing}>
                {syncing ? "フォルダ同期を実行中..." : "確認してフォルダ同期を実行"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== FILE HISTORY MODAL ==================== */}
      {historyFileResult && (
        <div className="modal-overlay">
          <div className="modal-content modal-history-detail" style={{ maxWidth: '750px' }}>
            <div className="modal-header">
              <div className="detail-path-title">
                <span>ファイル履歴</span>
                <h3 className="title-with-spike" style={{ marginTop: '0.25rem' }}>
                  <RadialSpikeIcon size={22} style={{ color: 'var(--color-primary)' }} />
                  <span>{historyFileResult.fileName} の同期履歴</span>
                </h3>
              </div>
              <button 
                className="btn btn-secondary btn-icon" 
                onClick={() => setHistoryFileResult(null)}
                style={{ fontSize: '1.2rem', padding: '0.2rem 0.6rem' }}
                title="閉じる"
              >
                ✕
              </button>
            </div>

            <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-body)', marginBottom: '1.2rem', padding: '0.8rem 1rem', background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)' }}>
                {historyFileResult.relativePath && (
                  <div style={{ marginBottom: '0.3rem' }}><strong>相対パス:</strong> <span style={{ fontFamily: 'var(--font-mono)' }}>{historyFileResult.relativePath}</span></div>
                )}
                {historyFileResult.leftPath && (
                  <div style={{ marginBottom: '0.3rem' }}><strong>左側絶対パス:</strong> <span style={{ fontFamily: 'var(--font-mono)' }}>{historyFileResult.leftPath}</span></div>
                )}
                {historyFileResult.rightPath && (
                  <div><strong>右側絶対パス:</strong> <span style={{ fontFamily: 'var(--font-mono)' }}>{historyFileResult.rightPath}</span></div>
                )}
              </div>

              {(() => {
                const fileHistories = getFileHistories(historyFileResult);
                if (fileHistories.length === 0) {
                  return (
                    <div className="empty-state" style={{ padding: '2rem 1rem' }}>
                      <div className="empty-state-icon" style={{ fontSize: '2rem' }}>⏱️</div>
                      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                        このファイルの同期履歴はまだ存在しません。
                      </p>
                    </div>
                  );
                }

                return (
                  <div className="history-timeline" style={{ marginTop: '0.5rem' }}>
                    {fileHistories.map((h) => (
                      <div key={h.id} className={`history-node ${h.status}`} style={{ padding: '1rem', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', marginBottom: '1rem', background: 'var(--color-canvas)' }}>
                        <div className="history-node-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                          <div className="history-meta-top" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                            <span className="history-action-text" style={{ fontWeight: '600', fontSize: '0.88rem' }}>
                              {h.status === "restored" ? "↩️ 復元操作" : "⇄ 同期適用"}
                            </span>
                            <span className="history-time" style={{ fontSize: '0.8rem', color: 'var(--color-muted)' }}>
                              {new Date(h.createdAt).toLocaleString("ja-JP")}
                            </span>
                          </div>
                          
                          {h.status === "success" && (
                            <button 
                              className="btn btn-secondary btn-danger" 
                              style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem' }}
                              onClick={() => handleRestoreFileHistory(h.id)}
                            >
                              ↩️ この時点に復元
                            </button>
                          )}

                          {h.status === "restored" && (
                            <span className="badge badge-same" style={{ background: 'rgba(139, 92, 246, 0.15)', color: '#7c3aed', padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}>
                              復元済み
                            </span>
                          )}
                        </div>

                        <div className="history-node-body" style={{ fontSize: '0.85rem', color: 'var(--color-body)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div>
                            <strong>方向:</strong> {h.direction === "leftToRight" ? "左 ➔ 右 (適用)" : "右 ➔ 左 (適用)"}
                          </div>
                          <div style={{ wordBreak: 'break-all' }}>
                            <strong>同期元:</strong> <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{h.sourcePath}</span>
                          </div>
                          <div style={{ wordBreak: 'break-all' }}>
                            <strong>同期先:</strong> <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{h.targetPath}</span>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--color-muted)', marginTop: '0.2rem', background: 'var(--color-surface-soft)', padding: '0.2rem 0.4rem', borderRadius: '4px', width: 'fit-content' }}>
                            Commit ID: {h.commitId.substring(0, 10)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setHistoryFileResult(null)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
