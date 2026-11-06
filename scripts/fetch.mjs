// オーバーウォッチ公式「ヒーロー統計」から勝率データを取得し、docs/data/stats.json を更新する。
// 取得条件（固定）：ライバル・プレイ（rq=1）／マウス＆キーボード（input=PC）／アジア／全ティア／全ロール
// 先週分は1世代だけ残す（前回更新から20時間以上たっていれば繰り上げ、20時間未満なら引き継ぐ）。
// 取得や検証に失敗したときは、ファイルを書き換えずに終了コード1で終わる。
// Node.js 20 以上（追加パッケージ不要）

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "docs/data/stats.json");
const BASE = "https://overwatch.blizzard.com/ja-jp/rates/";
const urlFor = (map) => `${BASE}?input=PC&map=${encodeURIComponent(map)}&region=Asia&role=All&rq=1&tier=All`;
const ROTATE_HOURS = 20;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ---- HTML解析（ブラウザ検証でも同じ関数を使用） ----
export function decodeEntities(s) {
  return s
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, "&");
}

export function selectBody(html, id) {
  const m = html.match(new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`));
  return m ? m[1] : null;
}

// マップ一覧（モード＝optgroup のラベル付き）
export function parseMaps(html) {
  const body = selectBody(html, "filter-map-select");
  if (!body) throw new Error("マップ一覧が見つかりません");
  const out = [];
  let mode = "";
  const re = /<optgroup\b[^>]*\blabel="([^"]*)"|<option\b([^>]*)>([\s\S]*?)<\/option>/g;
  let t;
  while ((t = re.exec(body))) {
    if (t[1] !== undefined) { mode = decodeEntities(t[1]).trim(); continue; }
    const v = (t[2].match(/\bvalue="([^"]*)"/) || [])[1];
    if (!v || v === "all-maps") continue;
    out.push({ id: decodeEntities(v), label: decodeEntities(t[3].replace(/<[^>]*>/g, "")).trim(), mode: mode || "その他" });
  }
  return out;
}

export function selectedValue(html, id) {
  const body = selectBody(html, id);
  if (!body) return null;
  const re = /<option\b([^>]*)>/g;
  let t;
  while ((t = re.exec(body))) {
    if (/\bselected\b/.test(t[1])) return (t[1].match(/\bvalue="([^"]*)"/) || [])[1] ?? null;
  }
  return null;
}

export function parseRows(html) {
  const m = html.match(/<blz-data-table\b[\s\S]*?\sallrows="([^"]*)"/);
  if (!m) throw new Error("データ表が見つかりません");
  const rows = JSON.parse(decodeEntities(m[1]));
  return rows.map((r) => ({
    id: r.id,
    name: r.cells && r.cells.name,
    role: ((r.hero && r.hero.role) || "").toLowerCase(),
    win: r.cells && r.cells.winrate,
    pick: r.cells && r.cells.pickrate,
    ban: r.cells && r.cells.banrate,
  }));
}

// ---- 取得 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8", accept: "text/html" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      await sleep(3000 * i);
    }
  }
  throw new Error(`${url} の取得に失敗：${last && last.message}`);
}

// ---- 診断（公式との数値ずれの原因調査用。データの更新には影響しない） ----
// 同じページを「通常」「キャッシュ回避」の2通りで取得し、返ってきた情報と数値を比べてログに出す
const DIAG = true;
const DIAG_MAPS = ["numbani", "route-66", "busan"];
const DIAG_HEROES = ["reinhardt", "echo", "vendetta", "kiriko", "winston"];
const DIAG_HEADERS = ["date", "age", "cache-control", "expires", "last-modified", "etag", "x-cache", "x-cache-hits", "cf-cache-status", "x-served-by", "x-amz-cf-pop", "x-amz-cf-id", "via", "server", "vary", "x-akamai-transformed", "server-timing"];

async function diagFetch(url, noCache) {
  const headers = { "user-agent": UA, "accept-language": "ja,en;q=0.8", accept: "text/html" };
  if (noCache) Object.assign(headers, { "cache-control": "no-cache", pragma: "no-cache" });
  const res = await fetch(url, { headers, cache: "no-store" });
  const html = await res.text();
  return { res, html };
}

async function diagnose() {
  const { createHash } = await import("node:crypto");
  const jst = (d) => new Date(d).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  console.log("==================== 診断ここから ====================");
  console.log(`診断時刻（日本時間）：${jst(Date.now())}`);
  console.log("※この直後に公式ページを開き、下の「数値」と見比べてください");
  for (const map of DIAG_MAPS) {
    const variants = [
      ["A 通常", urlFor(map), false],
      ["B キャッシュ回避", urlFor(map) + "&_cb=" + Date.now(), true],
    ];
    const hashes = [];
    for (const [label, url, noCache] of variants) {
      try {
        const { res, html } = await diagFetch(url, noCache);
        console.log(`--- ${map} / ${label}：HTTP ${res.status}（${html.length}文字）`);
        const hs = DIAG_HEADERS.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v);
        hs.forEach(([h, v]) => console.log(`    [応答] ${h}: ${String(v).slice(0, 160)}`));
        const date = res.headers.get("date"), lm = res.headers.get("last-modified"), age = res.headers.get("age");
        if (date) console.log(`    [応答] date（日本時間）: ${jst(date)}`);
        if (lm) console.log(`    [応答] last-modified（日本時間）: ${jst(lm)}`);
        if (age) console.log(`    [応答] 保存されてからの秒数（age）: ${age}秒（約${Math.round(Number(age) / 60)}分）`);
        let rows = [];
        try { rows = parseRows(html); } catch (e) { console.log("    データ表なし：" + e.message); }
        const m = html.match(/<blz-data-table\b[\s\S]*?\sallrows="([^"]*)"/);
        hashes.push(m ? createHash("sha256").update(m[1]).digest("hex").slice(0, 12) : "なし");
        console.log(`    rq=${selectedValue(html, "filter-rq-select")} region=${selectedValue(html, "filter-region-select")} input=${selectedValue(html, "filter-input-select")} tier=${selectedValue(html, "filter-tier-select")} map=${selectedValue(html, "filter-map-select")}`);
        for (const id of DIAG_HEROES) {
          const r = rows.find((x) => x.id === id);
          if (r) console.log(`    数値 ${r.name}：勝率 ${r.win} ／ ピック率 ${r.pick} ／ BAN率 ${r.ban}`);
        }
        // ページ内の日時らしき文字列や、データ取得先らしきURLの手がかり
        const stamps = [...new Set(html.match(/20\d\d-\d\d-\d\d[T ]\d\d:\d\d(:\d\d)?(\.\d+)?Z?/g) || [])].slice(0, 5);
        if (stamps.length) console.log(`    ページ内の日時：${stamps.join(" , ")}`);
        const tag = (html.match(/<blz-data-table\b[^>]*?(?=\sallrows=)/) || [""])[0].replace(/\s+/g, " ").slice(0, 300);
        if (tag) console.log(`    表タグ：${tag}`);
        const apis = [...new Set(html.match(/["'](https?:\/\/[^"']*(?:api|rates|data)[^"']*|\/[^"'\s]*(?:api|rates\/data)[^"'\s]*)["']/gi) || [])].slice(0, 8);
        if (apis.length) console.log(`    取得先の候補：${apis.join(" , ")}`);
      } catch (e) {
        console.log(`--- ${map} / ${label}：取得失敗 ${e.message}`);
        hashes.push("失敗");
      }
      await sleep(800);
    }
    console.log(`    → A と B のデータは${hashes[0] === hashes[1] ? "同じ" : "違う"}（${hashes.join(" / ")}）`);
  }
  console.log("==================== 診断ここまで ====================");
}

async function main() {
  const now = new Date();
  console.log("取得開始", now.toISOString());
  if (DIAG) {
    try { await diagnose(); } catch (e) { console.log("診断でエラー（更新は続行）：" + e.message); }
  }

  const top = await get(urlFor("all-maps"));
  const maps = parseMaps(top);
  if (maps.length < 10) throw new Error(`マップ数が少なすぎます（${maps.length}）`);

  const heroes = {};
  const fetched = [];
  for (const m of maps) {
    const html = await get(urlFor(m.id));
    const rq = selectedValue(html, "filter-rq-select");
    if (rq !== "1") throw new Error(`${m.label}：ライバル・プレイのデータではありません（rq=${rq}）`);
    const rows = parseRows(html);
    if (rows.length < 30) throw new Error(`${m.label}：ヒーロー数が少なすぎます（${rows.length}）`);
    rows.forEach((r) => { heroes[r.id] = [String(r.name), r.role]; });
    fetched.push({ ...m, rows: rows.map((r) => [r.id, r.win, r.pick, r.ban]) });
    console.log(`  ${m.mode} / ${m.label}：${rows.length}人`);
    await sleep(800);
  }

  // 検証
  const roles = new Set(Object.values(heroes).map((h) => h[1]));
  for (const r of roles) if (!["tank", "damage", "support"].includes(r)) throw new Error(`想定外のロール：${r}`);
  const banMax = Math.max(...fetched.flatMap((m) => m.rows.map((r) => (typeof r[3] === "number" ? r[3] : 0))));
  if (!(banMax > 0)) throw new Error("BAN率がすべて0です（ライバル・プレイのデータではない可能性）");

  // 先週分（1世代）の繰り上げ
  let old = null;
  try { old = JSON.parse(await readFile(OUT, "utf8")); } catch { old = null; }
  const oldMaps = new Map(((old && old.maps) || []).map((m) => [m.id, m]));
  const oldAt = old && old.updatedAt ? new Date(old.updatedAt) : null;
  const rotate = !!oldAt && !isNaN(oldAt) && now - oldAt >= ROTATE_HOURS * 3600 * 1000;
  const prevUpdatedAt = rotate ? old.updatedAt : (old && old.prevUpdatedAt) || null;

  const outMaps = fetched.map((m) => {
    const o = oldMaps.get(m.id);
    let prevRows = [];
    if (o) {
      prevRows = rotate
        ? (o.rows || []).filter((r) => typeof r[1] === "number").map((r) => [r[0], r[1]])
        : o.prevRows || [];
    }
    return { id: m.id, label: m.label, mode: m.mode, rows: m.rows, prevRows };
  });

  const data = {
    updatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    prevUpdatedAt,
    conditions: "ライバル・プレイ／マウス＆キーボード／アジア／全ティア",
    heroes,
    maps: outMaps,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data) + "\n", "utf8");

  const added = outMaps.filter((m) => !oldMaps.has(m.id)).map((m) => m.label);
  const removed = [...oldMaps.values()].filter((m) => !outMaps.some((x) => x.id === m.id)).map((m) => m.label);
  console.log(`完了：${outMaps.length}マップ・${Object.keys(heroes).length}人／先週分：${rotate ? "繰り上げ" : "引き継ぎ"}（${prevUpdatedAt || "なし"}）`);
  if (added.length) console.log("追加されたマップ：" + added.join(", "));
  if (removed.length) console.log("なくなったマップ：" + removed.join(", "));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("失敗：" + e.message + "（データは更新していません）");
    process.exit(1);
  });
}
