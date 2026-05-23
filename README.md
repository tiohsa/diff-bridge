# diff-bridge 🌉

Tauriをベースに構築された、高性能で美しいデスクトップ向け差分（Diff）比較・同期アプリケーション。  
通常のローカルファイルシステムはもちろん、**WSL2（Windows Subsystem for Linux 2）** 環境のファイルパスにもネイティブ対応し、開発者の日々の作業における「ファイルの比較」「安全な同期」「履歴追跡」「過去状態への復元」を強力にサポートします。

---

## 🌟 主な特徴 (Key Features)

### 📁 ディレクトリ一括比較 (Bulk Diff)
- 2つのディレクトリを選択し、内部の複数ファイルを高速にスキャン・比較。
- 相対パス一致を標準とし、オプションでファイル名のみ一致するファイルの抽出にも対応。
- 左右のディレクトリそれぞれに配置された `.gitignore` ルールを独立して自動参照し、不要なファイル（`.git` や依存関係フォルダなど）を比較対象からインテリジェントに除外。

### 📄 指定ファイル比較 (Specified Diff)
- ファイル名や配置場所が異なる任意の2ファイルをユーザーが明示的に選択し、内容を詳細に比較可能。

### 🔄 双方向・片方向のファイル同期 (File Sync)
- 比較結果一覧、または差分詳細画面から、安全な「ファイル単位同期」および「作成同期」を実行可能。
- 同期実行前に必ず確認プレビューを表示し、誤操作による意図しない上書きを防止。
- 外部プロセスによる突発的なファイル変更を検知する「外部変更検知」機能を搭載し、安全性を最優先した設計。

### 📜 アプリ専用Git履歴管理 & 復元 (Sync History & Restore)
- 同期操作の前後のファイル状態を自動的にスナップショット化し、**アプリ専用のGit管理領域**へコミットとして記録。
- ユーザーの作業用Gitリポジトリの履歴を汚すことなく、安全に同期履歴を追跡可能。
- 履歴画面から、過去の任意の同期操作前の状態へとワンクリックで安全に復元。

### 🐧 WSL2 (Windows Subsystem for Linux) ネイティブ対応
- Windows環境において、`\\wsl.localhost\<DistributionName>\...` または `\\wsl$\...` 形式のLinuxファイルシステムパスをシームレスに認識・比較可能。
- Windows通常フォルダとWSL2内フォルダを左右に混在させたクロス環境比較・同期も完全にサポート。

---

## 🎨 洗練されたデザインシステム

`diff-bridge` は、美しさと機能性の両立を追求しています。[DESIGN.md](file:///c:/Users/glory/sources/repos/diff-bridge/DESIGN.md) に定義された厳格なビジュアルアイデンティティに100%準拠しています。

- **Canvas (暖かみのあるクリーム背景)**: オフホワイトやクールグレーの単調さを排除した `--color-canvas` (`#faf9f5`) による上品な基調。
- **Primary Coral (アクセント・プライマリ)**: 重要なボタンやボーダーを情緒的に引き立てる `--color-primary` (`#cc785c`)。
- **Surface Dark (製品ダーク面)**: コード差分やログ表示エリアには、エディトリアルな明暗のコントラストを作る深みのある `--color-surface-dark` (`#181715`) を採用。
- **美しいタイポグラフィ**: タイトル見出しにはエディトリアルな Serif系フォント、標準UIには可読性の高い Sans-serif系、コード・パス表示には等幅フォント（JetBrains Mono）を厳密に配置。

---

## 🛠️ 技術スタック (Technology Stack)

- **Frontend**: React 19 / TypeScript / Vite / Vanilla CSS (Tailwind CSS 等のCSSフレームワークは非採用)
- **Backend (Tauri)**: Rust 1.77+ / Tauri v2
- **State Management**: React Standard State & Custom Event Hooks (依存関係を最小限に抑えたクリーンなステート設計)

---

## 🚀 開発環境のセットアップ (Dev Environment Setup)

### 前提条件
- **Node.js**: v18以上 (パッケージマネージャーとして `pnpm` を使用)
- **Rust**: 1.77以上 (Tauri用ツールチェーン)
- **Git**: 履歴管理機能のバックエンドとして動作

### 1. 依存関係のインストール
```bash
pnpm install
```

### 2. 開発サーバーの起動
フロントエンドのホットリロード、およびRustバックエンドのライブコンパイルを伴う開発サーバーを起動します。
```bash
pnpm tauri dev
```

### 3. ビルド (Production Build)
```bash
# フロントエンドの型チェックと静的ビルド
pnpm build

# Tauriアプリケーション全体の製品用ビルド
pnpm tauri build
```

---

## 📂 プロジェクトのディレクトリ構成 (Directory Structure)

```
diff-bridge/
├── DESIGN.md           # 厳格なビジュアル・デザインシステム定義書
├── AGENTS.md           # AIエージェント開発基準・アーキテクチャ解説書
├── package.json        # フロントエンドの依存関係および各種コマンド
├── src/                # フロントエンドソースコード (React 19 / TS)
│   ├── main.tsx        # エントリーポイント
│   ├── App.tsx         # メインUIコンポーネント (各サブ画面コンポーネントを内包)
│   ├── App.css         # アプリ全体のスタイル (Vanilla CSS定義)
│   ├── api.ts          # Tauriコマンド呼び出し (invoke) の型安全ラッパー
│   └── types.ts        # フロント・バックエンド共有用の共用型定義
└── src-tauri/          # バックエンドソースコード (Tauri v2 / Rust)
    ├── Cargo.toml      # Rustクレート依存関係
    ├── tauri.conf.json # Tauriアプリ基本設定
    └── src/
        ├── main.rs     # 起動用メインエントリー
        ├── lib.rs      # コマンドの登録およびTauriビルド構成
        ├── commands.rs # フロントエンドに公開するAPIコマンド定義
        ├── diff_engine.rs # ディレクトリ/ファイル差分の高速抽出・同期ロジック
        ├── git_history.rs # Git履歴取得・コミット関連処理
        └── models.rs   # フロント・バックエンド間シリアライズ用データモデル
```

---

## 🤝 開発・貢献のガイドライン

本プロジェクトで新機能の実装やUIの調整を行う際は、必ず以下のドキュメントを参照し、基準を満たしていることを確認してください。

1. **ビジュアル設計**: [DESIGN.md](file:///c:/Users/glory/sources/repos/diff-bridge/DESIGN.md) に定義されたカラーパレット、余白、タイポグラフィ、コントラストを必ず遵守してください。
2. **AIエージェント・開発標準**: [AGENTS.md](file:///c:/Users/glory/sources/repos/diff-bridge/AGENTS.md) を一読し、型安全なAPIラッパー設計、Rust側でのエラーハンドリング (`Result<T, String>`), WSL2 パス対応におけるOS固有セパレータの吸収などのベストプラクティスに従ってください。

---

## 📄 ライセンス

本プロジェクトのコードは、ライセンス規定に基づいて提供されています。詳細はリポジトリの管理者にお問い合わせください。
