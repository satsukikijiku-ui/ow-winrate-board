// ティア表のカード画像と共有用ページを、全マップ分まとめて作る（GitHub Actions で公開のたびに実行）
// ・公開用フォルダ（SITE_DIR。ワークフローでは docs をコピーした _site）のボードを
//   ブラウザ（Playwright の Chromium）で開き、ボードと同じ描き方で画像を作る
// ・〈公開用フォルダ〉/tier/〈マップ〉.png   … リンクカード用の画像（1200×630）
// ・〈公開用フォルダ〉/share/〈マップ〉.html … 共有用ページ。X・Discord がこのページの画像をカードとして表示する。
//                                           人が開くと、そのマップを選んだ状態のボードへ移動する
// ・〈公開用フォルダ〉/tier/index.json       … 作った日時とマップ一覧（ボードはこれを見て、共有用ページを使うか決める）
// カード画像はリポジトリには保存しない（公開されるのは常に最新の1世代だけ。古い世代は残らない）
// 失敗しても勝率データの更新には影響しない（ワークフロー側で continue-on-error にしている）

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = resolve(ROOT, process.env.SITE_DIR || "docs");
const TIER_DIR = resolve(DOCS, "tier");
const SHARE_DIR = resolve(DOCS, "share");

// 公開URL（例：https://satsukikijiku-ui.github.io/ow-winrate-board/）。BOARD_URL があればそれを使う
function boardUrl() {
  if (process.env.BOARD_URL) return process.env.BOARD_URL.replace(/\/?$/, "/");
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo) throw new Error("公開URLが分かりません（BOARD_URL か GITHUB_REPOSITORY が必要です）");
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo}/` : `https://${owner}.github.io/${repo}/`;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".png": "image/png", ".css": "text/css" };

// docs フォルダをそのまま配る小さなサーバー
function serveDocs() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (path.endsWith("/")) path += "index.html";
      const file = resolve(DOCS, "." + path);
      if (file !== DOCS && !file.startsWith(DOCS + sep)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sharePage({ base, map, stamp, when }) {
  const title = `${map.label} ティア表｜OW勝率ボード`;
  const desc = `オーバーウォッチ ライバル・プレイ（マウス＆キーボード／アジア）の ${map.label}（${map.mode}）勝率ティア表。集計日 ${when}。非公式ファンツール。`;
  const img = `${base}tier/${map.id}.png?v=${stamp}`;
  const page = `${base}share/${map.id}.html`;
  const to = `../?map=${encodeURIComponent(map.id)}`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OW勝率ボード">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(map.label)} の勝率ティア表（S〜D）">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="theme-color" content="#11161e">
<style>
body { margin: 0; background: #11161e; color: #e6ebf2; font-family: system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
img { width: 100%; height: auto; border-radius: 6px; display: block; }
a { color: #f08a26; }
</style>
<script>location.replace(${JSON.stringify(to)});</script>
</head>
<body>
<main>
  <p>OW勝率ボードへ移動しています… 移動しない場合は <a href="${esc(to)}">こちら</a></p>
  <img src="../tier/${esc(map.id)}.png?v=${esc(stamp)}" alt="${esc(map.label)} の勝率ティア表">
</main>
</body>
</html>
`;
}

async function main() {
  const base = boardUrl();
  const server = await serveDocs();
  const local = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    page.on("pageerror", (e) => console.log("  ページのエラー：" + e.message));
    await page.goto(local + "?render=1", { waitUntil: "load" });
    await page.waitForFunction(() => window.__owTier && typeof window.__owTier.ready === "function", null, { timeout: 30000 });
    await page.evaluate(() => window.__owTier.ready());
    const maps = await page.evaluate(() => window.__owTier.maps());
    const info = await page.evaluate(() => window.__owTier.info());
    const stamp = await page.evaluate(() => window.__owTier.stamp());
    if (!maps.length || !info || !info.updatedAt) throw new Error("データが読み込めませんでした");
    const when = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(info.updatedAt));

    await mkdir(TIER_DIR, { recursive: true });
    await mkdir(SHARE_DIR, { recursive: true });
    for (const map of maps) {
      if (!/^[a-z0-9-]+$/.test(map.id)) { console.log(`  とばしました（想定外のID）：${map.id}`); continue; }
      const dataUrl = await page.evaluate((id) => window.__owTier.card(id), map.id);
      const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
      await writeFile(join(TIER_DIR, `${map.id}.png`), png);
      await writeFile(join(SHARE_DIR, `${map.id}.html`), sharePage({ base, map, stamp, when }), "utf8");
      console.log(`  ${map.mode} / ${map.label}：${Math.round(png.length / 1024)}KB`);
    }

    // なくなったマップの古いファイルを消す
    const keep = new Set(maps.map((m) => m.id));
    for (const [dir, ext] of [[TIER_DIR, ".png"], [SHARE_DIR, ".html"]]) {
      for (const f of await readdir(dir)) {
        if (f.endsWith(ext) && !keep.has(f.slice(0, -ext.length))) { await unlink(join(dir, f)); console.log(`  削除：${f}`); }
      }
    }
    await writeFile(join(TIER_DIR, "index.json"), JSON.stringify({ updatedAt: info.updatedAt, stamp, maps: maps.map((m) => m.id) }) + "\n", "utf8");
    console.log(`完了：${maps.length}マップのカード画像と共有用ページを作りました（${base}share/〈マップ〉.html）`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error("失敗：" + e.message + "（ティア表のカード画像は更新していません）");
  process.exit(1);
});
