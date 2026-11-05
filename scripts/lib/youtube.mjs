// The Council's YouTube channel: every video the channel's public feed has listed.
//
// YouTube's feed (no key, no account) holds only the latest 15 videos, so each build merges it into
// data/youtube.json and that file keeps the full history. Title, description and views are refreshed
// while a video is still in the feed. A failed download is not fatal: the stored videos stay.
import { readJSON, writeJSON, log, warn } from "./util.mjs";

const FILE = "data/youtube.json";

const unescapeXml = (s) => String(s ?? "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? unescapeXml(m[1]).trim() : null; };

export function parseFeed(xml) {
  return xml.split("<entry>").slice(1).map((e) => ({
    id: tag(e, "yt:videoId"),
    title: tag(e, "title"),
    published: tag(e, "published"),
    description: tag(e, "media:description") ?? "",
    views: Number((e.match(/<media:statistics views="(\d+)"/) || [])[1] ?? NaN),
  })).filter((v) => v.id);
}

export async function updateYoutube(config) {
  const store = readJSON(FILE, { videos: {} });
  const id = config.youtube?.channelId;
  if (!id) return store;
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feed = parseFeed(await res.text());
    let added = 0;
    for (const v of feed) {
      if (!store.videos[v.id]) added++;
      store.videos[v.id] = { ...store.videos[v.id], ...v, views: Number.isFinite(v.views) ? v.views : store.videos[v.id]?.views ?? null, viewsAt: new Date().toISOString() };
    }
    store.updatedAt = new Date().toISOString();
    writeJSON(FILE, store);
    log(`youtube: ${feed.length} videos in the feed, ${added} new, ${Object.keys(store.videos).length} stored`);
  } catch (e) {
    warn(`youtube: feed could not be read (${e.message}); the stored videos are used`);
  }
  return store;
}
