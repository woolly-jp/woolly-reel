#!/usr/bin/env python3
"""Google側から「作る動画」の注文を受け取り、動画を書き出して結果を返す。

GitHub Actions から定期的に呼ばれる。必要な環境変数:
    WEBAPP_URL  … Google側(Apps Script)のURL
    WEBAPP_KEY  … 合言葉
    PAGES_BASE  … 動画を公開する場所(例: https://ユーザー名.github.io/woolly-reel)

    python3 run_job.py --check   注文があるかだけ確認する
    python3 run_job.py           注文をすべて処理する
"""
import base64
import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "v"
BGM = ROOT / "assets" / "bgm_quiet_piano.m4a"
URL = os.environ.get("WEBAPP_URL", "")
KEY = os.environ.get("WEBAPP_KEY", "")
PAGES = os.environ.get("PAGES_BASE", "").rstrip("/")
if not PAGES and "/" in os.environ.get("GITHUB_REPOSITORY", ""):
    _owner, _repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
    PAGES = f"https://{_owner.lower()}.github.io/{_repo}"
KEEP_DAYS = 30


def call(action, **params):
    """Google側に問い合わせる。Googleが一時的に遅い・不調なときは、間をあけて3回まで試す"""
    q = urllib.parse.urlencode(dict(action=action, key=KEY, **params))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(f"{URL}?{q}", timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            if attempt == 2:
                raise
            print(f"Google側の応答がありません({e})。30秒後にもう一度試します", file=sys.stderr)
            time.sleep(30)


def report(payload):
    body = json.dumps(dict(payload, key=KEY)).encode("utf-8")
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8")


def fetch(spec, folder, stem):
    """素材を1つ手元に保存する。サイトの写真はURLから、フォルダの素材はGoogle側から"""
    if spec.get("url"):
        ext = pathlib.PurePosixPath(urllib.parse.urlparse(spec["url"]).path).suffix or ".jpg"
        path = folder / f"{stem}{ext}"
        safe = urllib.parse.quote(spec["url"], safe=":/?&=%#+,;@~")  # 日本語を含むURLにも対応
        req = urllib.request.Request(safe, headers={"User-Agent": "woolly-reel"})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
        return str(path)
    data = call("file", id=spec["drive_id"])
    if data.get("error"):
        raise RuntimeError(f"素材を取得できません: {data['error']}")
    ext = pathlib.PurePosixPath(data["name"]).suffix.lower() or ".jpg"
    path = folder / f"{stem}{ext}"
    path.write_bytes(base64.b64decode(data["b64"]))
    return str(path)


def build(job, folder):
    cfg = dict(job["config"])
    for key, spec in job.get("files", {}).items():
        cfg[key] = fetch(spec, folder, key)
    cfg["bgm"] = str(BGM) if BGM.exists() else ""
    cfg_path = folder / "config.json"
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / job["file_name"]
    subprocess.run([sys.executable, str(ROOT / "src" / "make_reel.py"), str(cfg_path), str(out)],
                   check=True, capture_output=True, text=True)
    return out


def prune():
    """古い動画を消す(ファイル名の先頭8桁が日付)"""
    limit = datetime.date.today() - datetime.timedelta(days=KEEP_DAYS)
    for f in OUT.glob("*.mp4"):
        try:
            if datetime.datetime.strptime(f.name[:8], "%Y%m%d").date() < limit:
                f.unlink()
        except ValueError:
            pass


def publish_files():
    """できた動画を公開場所に置く(リポジトリに保存してPagesで配信)"""
    if os.environ.get("NO_GIT"):
        return
    git = lambda *a: subprocess.run(["git", *a], cwd=ROOT, check=True)
    git("config", "user.name", "woolly-reel")
    git("config", "user.email", "woolly-reel@users.noreply.github.com")
    git("add", "-A", "docs/v")
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode != 0:
        git("commit", "-m", "動画を追加")
        git("push")


def main():
    if not URL or not KEY:
        sys.exit("WEBAPP_URL と WEBAPP_KEY を設定してください")
    if "--check" in sys.argv:
        try:
            n = call("peek").get("pending", 0)
        except Exception as e:
            # Googleの一時的な不調。失敗扱いにせず、次の回(2時間後)にまた見にいく
            print(f"::warning::Google側に接続できませんでした。次の回にもう一度確認します({e})")
            n = 0
        print(f"注文: {n}件")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as fh:
                fh.write(f"has_job={'true' if n else 'false'}\n")
        return
    done = []
    for _ in range(5):
        job = call("job")
        if not job.get("id"):
            break
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = build(job, pathlib.Path(tmp))
            done.append((job["id"], out.name))
            print(f"できました: {out.name}")
        except Exception as e:  # 失敗はGoogle側に伝え、スタッフにメールが届く
            detail = getattr(e, "stderr", "") or traceback.format_exc()
            print(detail, file=sys.stderr)
            report({"action": "failed", "id": job["id"], "error": str(detail)[-800:]})
    prune()
    if done:
        publish_files()
        for job_id, name in done:
            report({"action": "done", "id": job_id, "video_url": f"{PAGES}/v/{name}"})


if __name__ == "__main__":
    main()
