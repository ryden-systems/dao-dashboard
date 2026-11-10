// POLIS voting locks: how many wallets have POLIS locked for voting power, and the DAO's total
// voting power (PVP). Every locking wallet has one Escrow account in the locked-voter program
// (config.governance.polisLocker); one getProgramAccounts call per build reads them all, only the
// amount and the lock end of each, plus one read of the Locker for its voting rules.
// A lock that has ended gives no voting power, even while its POLIS is still in it.
import crypto from "node:crypto";
import { readJSON, writeJSON, log, warn, isoDay } from "./util.mjs";

const FILE = "data/polis_locks.json";
const DECIMALS = 8;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b) break; s = "1" + s; }
  return s;
}

// Escrow after its 8-byte type tag: locker 32, owner 32, bump 1, tokens 32, amount u64,
// escrowStartedAt i64, escrowEndsAt i64, voteDelegate 32. `buf` starts after the tag.
export const ESCROW_SLICE = { offset: 8, length: 121 };
export function decodeEscrow(buf) {
  return { amount: Number(buf.readBigUInt64LE(97)), endsAt: Number(buf.readBigInt64LE(113)) };
}

// Locker (whole account): tag 8, base 32, bump 1, tokenMint 32, lockedSupply u64, governor 32, then
// its params: whitelistEnabled bool, maxStakeVoteMultiplier u8, minStakeDuration u64, maxStakeDuration u64.
export function decodeLocker(buf) {
  const p = 8 + 32 + 1 + 32 + 8 + 32;
  return { multiplier: buf[p + 1], maxDuration: Number(buf.readBigUInt64LE(p + 10)) };
}

// Voting power of one lock (the locked-voter rule): amount x multiplier x time left / longest
// lock, the time left capped at the longest lock. 0 once the lock has ended.
export function lockPower(polis, secondsLeft, { multiplier, maxDuration }) {
  if (!(secondsLeft > 0) || !maxDuration) return 0;
  return (polis * multiplier * Math.min(secondsLeft, maxDuration)) / maxDuration;
}

// Counts for the Governance page. `now` in seconds; `rules` from decodeLocker.
export function summarizeLocks(rows, now, rules) {
  let running = 0, expired = 0, empty = 0, polisRunning = 0, polisExpired = 0, pvp = 0, pvpTime = 0;
  for (const r of rows) {
    if (!r.amount) { empty++; continue; }
    const polis = r.amount / 10 ** DECIMALS;
    const left = r.endsAt - now;
    if (left > 0) {
      running++; polisRunning += polis;
      const p = lockPower(polis, left, rules);
      pvp += p; pvpTime += p * left;
    } else { expired++; polisExpired += polis; }
  }
  return {
    accounts: rows.length, running, expired, empty,
    polisRunning: Math.round(polisRunning), polisExpired: Math.round(polisExpired),
    pvp: Math.round(pvp),
    // Time left of the running locks, each weighted by its voting power.
    pvpWeightedDaysLeft: pvp ? Math.round(pvpTime / pvp / 86400) : null,
    multiplier: rules.multiplier, maxLockDays: Math.round(rules.maxDuration / 86400),
  };
}

// Reads the locks with the first RPC that answers (some providers refuse getProgramAccounts) and
// keeps one summary per day. If none answers, the previous numbers stay.
export async function updatePolisLocks(rpcs, config) {
  const L = config.governance?.polisLocker;
  if (!L?.program || !L?.locker) return;
  const tag = crypto.createHash("sha256").update("account:Escrow").digest().subarray(0, 8);
  const params = [L.program, { encoding: "base64", dataSlice: ESCROW_SLICE, filters: [{ memcmp: { offset: 0, bytes: b58(tag) } }, { memcmp: { offset: 8, bytes: L.locker } }] }];
  for (const rpc of rpcs) {
    try {
      const locker = await rpc.call("getAccountInfo", [L.locker, { encoding: "base64" }]);
      if (!locker?.value) throw new Error("locker account not found");
      const rules = decodeLocker(Buffer.from(locker.value.data[0], "base64"));
      if (!rules.multiplier || !rules.maxDuration) throw new Error("locker rules could not be read");
      const res = await rpc.call("getProgramAccounts", params);
      if (!Array.isArray(res) || !res.length) throw new Error("no lock accounts returned");
      const now = Math.floor(Date.now() / 1000);
      const s = { at: new Date(now * 1000).toISOString(), ...summarizeLocks(res.map((a) => decodeEscrow(Buffer.from(a.account.data[0], "base64"))), now, rules) };
      const store = readJSON(FILE, { latest: null, days: {} });
      store.latest = s;
      store.days[isoDay(now)] = s;
      writeJSON(FILE, store);
      log(`polis locks: ${s.running} running, ${s.expired} expired, ${s.polisRunning} POLIS in running locks, ${s.pvp} PVP`);
      return;
    } catch (e) {
      warn(`polis locks: ${e.message}`);
    }
  }
  warn("polis locks: not read; the previous numbers stay");
}
