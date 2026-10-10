# Woolly Instagram 自動投稿

素材をフォルダに入れると、週2回、動画とキャプションが自動でできあがり、
スタッフが確認画面で「投稿する」を押すとInstagramに投稿される仕組みです。

## 中身

| 場所 | 役割 | 動く場所 |
| --- | --- | --- |
| `gas/` | 頭脳。フォルダ作成、商品・素材選び、文章づくり、確認画面、投稿、通知 | Google(Apps Script) |
| `src/` | 動画づくり。注文を受け取り、5.5秒の縦型動画を書き出す | GitHub(Actions) |
| `assets/` | BGM(自作の静かなピアノ)と、テスト用の仮画像 | |
| `docs/v/` | できた動画の置き場(GitHub Pagesで公開され、30日で自動的に消える) | |
| `test/` | Google側の代役を立てて全体を試すテスト | |

月額の費用は、文章づくりのAI利用料(ごくわずか)だけです。

## 設定の順番

くわしい手順は設計書の「構築手順」タブにあります。

1. GitHubに公開リポジトリを作ってこの一式を入れ、Pages(`main` ブランチの `/docs`)を有効にする
2. Googleで Apps Script を作り、`gas/` の3ファイルを貼り付けて `setup` を実行する
3. ウェブアプリとして公開し、URLと合言葉をGitHubの Secrets(`WEBAPP_URL`、`WEBAPP_KEY`)に入れる
4. スクリプト プロパティに `ANTHROPIC_API_KEY` と `IG_TOKEN` を入れ、`testAI`、`testInstagram` を実行する
5. `makeNow` を実行して、最初の投稿候補を作る

## 素材のきまり

- 画像は JPEG か PNG(iPhoneの HEIC は対象外)。縦長で入れる
- 動画は 30MB まで。使われるのは最初の約3秒。音は使わない
- 撮影した素材は、ファイル名を「実写」で始めると「イメージ画像」の札が付かない
- iPhoneのHDR動画は色が浅く見えることがある。その場合はHDRを切って撮る

## 手元で試す

```
python3 src/make_placeholders.py assets
node test/run.js                       # Google側の動きを確認
node test/server.js assets/任意の動画.mp4 &   # Google側の代役
WEBAPP_URL=http://127.0.0.1:8765/exec WEBAPP_KEY=(表示された合言葉) \
  PAGES_BASE=https://example.github.io/woolly-reel NO_GIT=1 python3 src/run_job.py
```

## まだ本番で確かめていないこと

- Apps Script 上での実行(テストは代役の環境で行った)
- Instagramへの実際の投稿(開発モードのアプリで自社アカウントに投稿できるか、を含む)
- GitHub Pages に置いた動画をInstagramが読み込めるか
