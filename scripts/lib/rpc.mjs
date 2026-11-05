// Minimal Solana JSON-RPC client with retry/backoff. No dependencies.
import { sleep } from "./util.mjs";

export function makeRpc(url, { minIntervalMs = 120 } = {}) {
  let id = 0, lastCall = 0, calls = 0;

  async function call(method, params) {
    for (let attempt = 0; attempt < 7; attempt++) {
      // Space calls out so the public endpoint's rate limit is respected.
      const wait = lastCall + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      calls++;
      let res, body;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        body = await res.json().catch(() => null);
      } catch (e) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) { await sleep(800 * 2 ** attempt); continue; }
      if (body?.error) {
        const msg = JSON.stringify(body.error);
        // Rate limits and temporary server errors surfaced in the JSON body.
        if (/rate|limit|429|too many|try again|long-term storage/i.test(msg)) { await sleep(800 * 2 ** attempt); continue; }
        throw new Error(`${method}: ${msg}`);
      }
      if (body && "result" in body) return body.result;
      await sleep(500 * 2 ** attempt);
    }
    throw new Error(`${method}: gave up after retries`);
  }

  return {
    call,
    get calls() { return calls; },

    // Every signature for an address newer than `until` (exclusive), newest first.
    // `startBefore` starts the walk at that signature instead of at the newest one.
    async signaturesSince(address, until, startBefore) {
      const out = [];
      let before = startBefore;
      for (;;) {
        const opts = { limit: 1000 };
        if (before) opts.before = before;
        if (until) opts.until = until;
        const page = await call("getSignaturesForAddress", [address, opts]);
        out.push(...page);
        if (page.length < 1000) break;
        before = page[page.length - 1].signature;
      }
      return out;
    },

    getTransaction(sig) {
      return call("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    },

    async tokenAccounts(owner, mint) {
      const r = await call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
      return r.value.map((v) => ({
        address: v.pubkey,
        amount: Number(v.account.data.parsed.info.tokenAmount.uiAmountString),
      }));
    },

    async solBalance(address) {
      const r = await call("getBalance", [address]);
      return r.value / 1e9;
    },
  };
}
