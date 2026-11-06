// OW勝率ボード 取得役（Vercel・東京 hnd1 で動かす）
// GitHub Actions から呼ばれ、日本から公式「ヒーロー統計」のページを取得して、そのまま返す。
// ・取得できるのは公式の勝率ページだけ（条件は固定、変えられるのはマップだけ）
// ・合言葉（環境変数 PROXY_KEY）が一致しないと使えない
// 使い方：
//   /api/fetch?map=numbani            … ページのHTMLを返す（合言葉は x-proxy-key ヘッダーで渡す）
//   /api/fetch?map=numbani&check=1&key=合言葉 … 確認用。動いている場所とラインハルト等の数値を表示

const BASE = "https://overwatch.blizzard.com/ja-jp/rates/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function cellValue(html, id, kind) {
  const m = html.match(new RegExp(`\\bid="${id}-${kind}-value"[^>]*>([^<]*)<`, "i"));
  return m ? m[1].trim() : null;
}

module.exports = async (req, res) => {
  const q = new URL(req.url, "http://localhost").searchParams;
  const key = process.env.PROXY_KEY || "";
  const given = String(req.headers["x-proxy-key"] || q.get("key") || "");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-proxy-region", process.env.VERCEL_REGION || "unknown");
  if (!key || given !== key) {
    res.status(403).send("forbidden");
    return;
  }
  const map = q.get("map") || "all-maps";
  if (!/^[a-z0-9-]{1,40}$/.test(map)) {
    res.status(400).send("bad map");
    return;
  }
  const target = `${BASE}?input=PC&map=${map}&region=Asia&role=All&rq=1&tier=All`;
  try {
    const r = await fetch(target, {
      cache: "no-store",
      headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8", accept: "text/html" },
    });
    const html = await r.text();
    if (q.get("check") === "1") {
      const pick = (id) => ({
        勝率: cellValue(html, id, "winrate"),
        ピック率: cellValue(html, id, "pickrate"),
        BAN率: cellValue(html, id, "banrate"),
      });
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.status(200).send(JSON.stringify({
        動いている場所: process.env.VERCEL_REGION || "unknown",
        公式の応答: r.status,
        マップ: map,
        ラインハルト: pick("reinhardt"),
        エコー: pick("echo"),
        レッキング・ボール: pick("wrecking-ball"),
      }, null, 2));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(r.status).send(html);
  } catch (e) {
    res.status(502).send("fetch failed: " + (e && e.message));
  }
};
