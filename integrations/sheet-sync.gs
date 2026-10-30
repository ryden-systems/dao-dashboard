/**
 * Star Atlas DAO Dashboard: sheet -> dashboard sync.
 *
 * Attach this script to the Council's Google Sheet (Extensions > Apps Script).
 * Every five minutes it takes a fingerprint of the sheet's contents. When the fingerprint
 * changes (an edit made in the sheet, or a save from the dashboard's editor), it asks GitHub
 * to rebuild the dashboard, exactly like pressing "Run workflow".
 *
 * Why polling and not onEdit: Google's edit triggers do not fire for changes made through the
 * Sheets API, so they would miss saves from the dashboard. A fingerprint check catches both.
 *
 * Setup (once): see README > "Instant updates from the sheet".
 *   1. Paste this file into the sheet's Apps Script editor and save.
 *   2. Project Settings > Script Properties: add
 *        GITHUB_REPO      e.g. star-atlas-dao/dashboard
 *        GITHUB_TOKEN     a fine-grained token for that one repository with "Actions: Read and write" only
 *        GITHUB_WORKFLOW  build.yml   (optional, this is the default)
 *        GITHUB_BRANCH    main        (optional, this is the default)
 *   3. Run "install" once from the editor and approve the permissions Google asks for.
 *
 * Cost: free. Runtime is about a second per check, well inside Apps Script's daily trigger quota.
 */

function install() {
  // Remove earlier copies of the trigger, then add one that runs every five minutes.
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === "checkForChanges"; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("checkForChanges").timeBased().everyMinutes(5).create();
  // Record the current state, so installing does not trigger a rebuild by itself.
  PropertiesService.getScriptProperties().setProperty("lastFingerprint", fingerprint_());
  Logger.log("Installed: the sheet is checked every five minutes.");
}

function uninstall() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === "checkForChanges"; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log("Removed: the sheet is no longer checked.");
}

function checkForChanges() {
  var props = PropertiesService.getScriptProperties();
  var current = fingerprint_();
  if (current === props.getProperty("lastFingerprint")) return;
  // Only remember the new state once GitHub accepted the request, so a failed call is retried.
  if (requestRebuild_()) props.setProperty("lastFingerprint", current);
}

/** Run this by hand to test the GitHub connection. */
function rebuildNow() {
  Logger.log(requestRebuild_() ? "Rebuild requested." : "Rebuild request failed; see the log above.");
}

function fingerprint_() {
  var tabs = SpreadsheetApp.getActive().getSheets().map(function (s) {
    return [s.getName(), s.getDataRange().getDisplayValues()];
  });
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(tabs), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(digest);
}

function requestRebuild_() {
  var p = PropertiesService.getScriptProperties();
  var repo = p.getProperty("GITHUB_REPO");
  var token = p.getProperty("GITHUB_TOKEN");
  var workflow = p.getProperty("GITHUB_WORKFLOW") || "build.yml";
  var branch = p.getProperty("GITHUB_BRANCH") || "main";
  if (!repo || !token) {
    Logger.log("GITHUB_REPO and GITHUB_TOKEN must be set in Script Properties.");
    return false;
  }
  var res = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + repo + "/actions/workflows/" + workflow + "/dispatches",
    {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      payload: JSON.stringify({ ref: branch }),
      muteHttpExceptions: true,
    }
  );
  var code = res.getResponseCode();
  if (code === 204) return true;
  // 401/403: token wrong or expired (renew it, see README). 404: repository or workflow name wrong.
  Logger.log("GitHub answered " + code + ": " + res.getContentText().slice(0, 300));
  return false;
}
