// Reads the Council's Google Sheet through its public CSV export.
// Columns are located by header text, so reordering columns in the sheet is safe.
import { parseCSV, clean, parseNum, fetchText } from "./util.mjs";


export function csvUrl(sheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

export async function fetchTabRaw(sheetId, gid) {
  return fetchText(csvUrl(sheetId, gid));
}

export async function fetchTab(sheetId, gid) {
  return parseCSV(await fetchTabRaw(sheetId, gid));
}

// Tab name -> gid, read from the sheet's public "htmlview" page. Lets config.json refer to tabs
// by name, so a tab the Council (or the dashboard's editor) creates later, such as
// "Payment labels", is picked up without anyone copying its gid into config.
// A name that is not found means the tab does not exist yet; it never falls back to another tab.
export async function fetchTabIndex(sheetId) {
  try {
    const html = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
    const index = {};
    for (const m of html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "[^"]*?gid=(\d+)/g)) {
      index[JSON.parse(`"${m[1]}"`)] = m[2];
    }
    return index;
  } catch {
    return {};
  }
}

export * from "./sheetparse.mjs";
