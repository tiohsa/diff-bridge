## Project Overview

`diff-bridge` は、Tauriをベースとした高性能デスクトップ差分・同期アプリケーションです。
複数のディレクトリやファイルの一括比較（Bulk Diff）、特定のファイルペア比較、双方向または単方向のファイル同期、Gitの履歴管理、およびWSL2（Windows Subsystem for Linux 2）環境におけるファイルパス対応などの高度な機能を備えています。

本ドキュメントは、このリポジトリで作業するすべてのAIエージェントが従うべき開発標準、アーキテクチャの解説、およびUIデザイン規約を定義するものです。

### Core Technology Stack

- **Frontend**: React 19 / TypeScript / Vite / Vanilla CSS
- **Backend (Tauri)**: Rust 1.77+ / Tauri v2
- **State Management**: React Standard State & Custom Event Hooks (Zundandなどの追加ライブラリは不使用、既存のシンプルなHooksモデルを使用)
- **Styling**: **Vanilla CSS (Strictly enforce `DESIGN.md`)**
  - Tailwind CSS やその他のCSSフレームワーク、外部コンポーネントライブラリは**使用禁止**です。

---

## Dev Environment Setup

プロジェクトでは `pnpm` をパッケージマネージャーとして採用しています。

### Dependencies Installation

```bash
pnpm install
```

### Running Development Server

Tauriの開発サーバー（フロントエンドのホットリロードおよびRustバックエンドのライブコンパイル）を起動します。

```bash
pnpm tauri dev
```

### Production Build

リリース用パッケージのビルドおよび動作検証のために使用します。

```bash
# フロントエンドの型チェックとビルド
pnpm build

# Tauriアプリケーション全体のビルド
pnpm tauri build
```

---

## Architecture

### Directory Structure

```
diff-bridge/
├── DESIGN.md           # 厳格なビジュアル・デザインシステム定義書
├── AGENTS.md           # 本ガイドライン（エージェント用開発標準）
├── package.json        # フロントエンド依存関係とスクリプト定義
├── src/                # フロントエンドソースコード (React 19 / TypeScript)
│   ├── main.tsx        # エントリーポイント
│   ├── App.tsx         # メインUIコンポーネント
│   ├── App.css         # アプリケーション全体の Vanilla CSS
│   ├── api.ts          # Tauriコマンド呼び出し (`invoke`) の型安全ラッパー
│   ├── types.ts        # 共用型定義（差分結果、同期ステータス等）
│   └── assets/         # 静的アセット
└── src-tauri/          # バックエンドソースコード (Tauri v2 / Rust)
    ├── Cargo.toml      # Rust依存関係定義
    ├── tauri.conf.json # Tauriアプリ設定
    ├── capabilities/   # Tauriのアクセスセキュリティ権限定義
    └── src/
        ├── main.rs     # 起動用メインエントリー
        ├── lib.rs      # コマンドの登録およびTauriビルド構成
        ├── commands.rs # フロントエンドに公開するAPIコマンド定義
        ├── diff_engine.rs # ディレクトリ/ファイル差分の抽出・同期ロジック
        ├── git_history.rs # Git履歴取得・コミット関連処理
        └── models.rs   # フロントエンドと共有するシリアライズ用データモデル
```

### Key Modules & Responsibilities

#### 1. Frontend (`src/`)
- [App.tsx](file:///c:/Users/glory/sources/repos/diff-bridge/src/App.tsx): 単一の肥大化したファイルを避けるため、各サブ画面（差分ビューアダイアログ、同期設定、WSL設定など）に適切に分割・整理します。UI状態や比較プロセス全体のフロー制御を担当します。
- [App.css](file:///c:/Users/glory/sources/repos/diff-bridge/src/App.css): アプリ内のすべてのコンポーネントスタイルはここで一元管理するか、機能ごとのCSSモジュールに整理します。
- [api.ts](file:///c:/Users/glory/sources/repos/diff-bridge/src/api.ts): Tauri コマンドとの通信インターフェースです。すべての `invoke` はここで型安全にラッピングされ、型不整合によるランタイムエラーを防ぎます。

#### 2. Backend (`src-tauri/src/`)
- [commands.rs](file:///c:/Users/glory/sources/repos/diff-bridge/src-tauri/src/commands.rs): フロントエンドからのリクエストを受ける関数群。`diff_engine` や `git_history` のロジックを呼び出し、結果を適切にフロントエンド用の型に変換して返します。
- [diff_engine.rs](file:///c:/Users/glory/sources/repos/diff-bridge/src-tauri/src/diff_engine.rs): フォルダやファイルの読み込み、ハッシュ値の比較、行ごとのテキスト差分（`similar` クレート等を利用した実装）など、パフォーマンスが要求されるコアな計算処理を実行します。
- [git_history.rs](file:///c:/Users/glory/sources/repos/diff-bridge/src-tauri/src/git_history.rs): リポジトリのGitコミットログ、差分履歴の追跡、同期結果自動コミットなどのGit連携機能を提供します。
- [models.rs](file:///c:/Users/glory/sources/repos/diff-bridge/src-tauri/src/models.rs): フロントエンド・バックエンド間でやり取りされるデータ形式を定義します。`#[derive(serde::Serialize, serde::Deserialize)]` を付与して定義してください。

---

## UI & Design System Rules (Strictly Enforced)

すべてのUI変更および新機能実装は、リポジトリルートにある [DESIGN.md](file:///c:/Users/glory/sources/repos/diff-bridge/DESIGN.md) のビジュアルアイデンティティに**100%準拠**していなければなりません。

### 1. Style Language: Vanilla CSS
- Tailwind CSS、CSS-in-JS、または他のUIフレームワーク（Radix, shadcn/ui, Bootstrap 等）を追加・使用することは**厳密に禁止**されています。
- [App.css](file:///c:/Users/glory/sources/repos/diff-bridge/src/App.css) に定義されているCSSカスタムプロパティ（CSS変数）を必ず利用してください。

### 2. Core Color Trinity (三位一体のブランドカラー)
`DESIGN.md` に基づき、以下のCSS変数またはカラーコードを徹底してください。

*   **Canvas (キャンバス背景)**: `--color-canvas` `#faf9f5`
    *   オフホワイトやクールグレーではなく、暖かみのあるクリーム調の背景を使用します。
*   **Primary Coral (アクセント・プライマリ)**: `--color-primary` `#cc785c`
    *   プライマリのCTAボタン、重要なボーダー、目立たせるインラインリンクにのみ使用します（多用しすぎないこと）。
*   **Surface Dark (製品ダーク面)**: `--color-surface-dark` `#181715`
    *   コードの差分比較表示、ターミナル出力パネル、コードエディタ風の表示領域に適用し、エディトリアルな明暗のコントラストを作ります。

### 3. Typography
- タイトルや見出し (H1, H2, H3) には、エディトリアルな雰囲気を持つ **Serif系フォント**（Cormorant Garamond, EB Garamond Fallbacks）を割り当てます。
- 本文、ナビゲーション、ラベル等の標準UI要素には、可読性の高い **Sans-serif系フォント**（Inter Fallback）を使用します。
- コード差分、ファイルパス、ログなどの等幅フォント領域には、**JetBrains Mono** または `monospace` を適用します。

### 4. Color Contrast Rhythm (画面レイアウトのコントラスト)
- 同一画面で同じ階調のエリアを連続させないでください。
- クリーム色のキャンバス背景 (`#faf9f5`) の上に、一段階深いカード領域 (`#efe9de`) や、コード差分用のネイビー領域 (`#181715`) を交互に配置し、読みやすい画面のリズムを構成します。

---

## Code Style & Best Practices

### TypeScript / React

1.  **Strict Mode**:
    *   TypeScriptの `strict` モードが有効です。あらゆる場所での `any` の使用を避け、インターフェースや型定義を明示的に指定してください。
2.  **Tauri API Wrapper**:
    *   `src/api.ts` を経由せずに直接 `@tauri-apps/api` の `invoke` をコンポーネント内で呼び出すことは避けてください。すべての通信関数は `api.ts` で型安全に管理します。
3.  **Modern React 19 Practices**:
    *   `use` や標準のフックを使い、依存関係を小さく保ちます。
    *   不要な再レンダリングを防ぐため、比較用データなどの巨大なステートは適切にメモ化（`useMemo`）し、差分描画のオーバーヘッドを抑えてください。

### Rust / Tauri

1.  **Type Safety & Serialization**:
    *   `src-tauri/src/models.rs` で定義する構造体は、フロントエンドに返却またはフロントエンドから入力される値と完全に一致させます。
2.  **Error Handling**:
    *   Tauriコマンドの戻り値には `Result<T, String>` を使用し、Rust側でのパニック（`unwrap()` による強制終了など）を決して発生させないでください。
    *   予期せぬIOエラーやGitコマンドエラーは `map_err(|e| e.to_string())` などの手法で文字列エラーに変換し、安全にフロントエンドへ通知します。
3.  **WSL2 & Path Processing**:
    *   Windowsの絶対パス（例: `C:\Users\...`）と WSL2 のパス（例: `\\wsl.localhost\Ubuntu\home\...`）を適切にハンドリングしてください。
    *   Rustの `std::path::Path` ユーティリティを使用し、OS固有のセパレータ（`\` と `/`）に依存しないコード設計を行います。

---

## PR & Implementation Workflow

AIエージェントが変更を行う際は、以下のワークフローを必ず実践してください。

1.  **Read and Understand**:
    *   実装に着手する前に、まず [DESIGN.md](file:///c:/Users/glory/sources/repos/diff-bridge/DESIGN.md) と本 [AGENTS.md](file:///c:/Users/glory/sources/repos/diff-bridge/AGENTS.md) を読み込み、スタイリングの基準を確認します。
2.  **Component Isolation**:
    *   UIを変更する場合、極力再利用可能な小さな関数コンポーネントに分離し、`App.tsx` の行数がこれ以上肥大化するのを防ぎます。
3.  **Verification**:
    *   コード修正後、必ず `pnpm build` を実行してTypeScriptの型エラーがないかチェックします。
    *   必要に応じて `pnpm tauri build` による本ビルド確認を行います。
4.  **Do Not Placeholders**:
    *   プレースホルダー画像やダミーデータを埋め込んだままにせず、動作する状態、もしくはモックデータとして整合性の取れた表示を完成させてください。
