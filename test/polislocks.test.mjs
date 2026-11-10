// POLIS lock counts (scripts/lib/polislocks.mjs): decoding, voting power and the summary.
import { decodeEscrow, decodeLocker, lockPower, summarizeLocks, ESCROW_SLICE } from "../scripts/lib/polislocks.mjs";

let failed = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { failed++; console.error("FAIL:", m); } };
const day = 86400;

// An Escrow slice as the RPC returns it (from offset 8): amount at 97, end at 113.
const slice = (amount, endsAt) => {
  const b = Buffer.alloc(ESCROW_SLICE.length);
  b.writeBigUInt64LE(BigInt(amount), 97);
  b.writeBigInt64LE(BigInt(endsAt), 113);
  return b;
};
const d = decodeEscrow(slice(1700000100000000, 1832771136));
ok(d.amount === 1700000100000000 && d.endsAt === 1832771136, "decode amount and lock end");

// A Locker account: params after tag, base, bump, mint, locked supply and governor.
const lk = Buffer.alloc(8 + 32 + 1 + 32 + 8 + 32 + 1 + 1 + 8 + 8 + 8);
const p = 8 + 32 + 1 + 32 + 8 + 32;
lk[p] = 1; lk[p + 1] = 10; lk.writeBigUInt64LE(1n, p + 2); lk.writeBigUInt64LE(BigInt(1825 * day), p + 10);
const rules = decodeLocker(lk);
ok(rules.multiplier === 10 && rules.maxDuration === 1825 * day, "decode locker rules");

ok(lockPower(100, 1825 * day, rules) === 1000, "full-length lock: 10x");
ok(lockPower(100, 3650 * day, rules) === 1000, "time left capped at the longest lock");
ok(Math.abs(lockPower(100, 182.5 * day, rules) - 100) < 1e-9, "a tenth of the time: 1x");
ok(lockPower(100, -1, rules) === 0, "ended lock: no power");

const now = 1_800_000_000;
const s = summarizeLocks([
  { amount: 100e8, endsAt: now + 365 * day },
  { amount: 100e8, endsAt: now + 1825 * day },
  { amount: 25e8, endsAt: now - day },
  { amount: 0, endsAt: now + day },
], now, rules);
ok(s.accounts === 4, "all accounts counted");
ok(s.running === 2 && s.expired === 1 && s.empty === 1, "running / expired / empty split");
ok(s.polisRunning === 200 && s.polisExpired === 25, "POLIS with 8 decimals, split by lock state");
ok(s.pvp === 1200, "total PVP of running locks (200 + 1000)");
// (200 x 365 + 1000 x 1825) / 1200 days
ok(s.pvpWeightedDaysLeft === Math.round((200 * 365 + 1000 * 1825) / 1200), "time left weighted by PVP");
ok(summarizeLocks([], now, rules).pvpWeightedDaysLeft === null, "no running locks: no average");

if (failed) { console.error(`${failed} of ${n} polis lock checks failed`); process.exit(1); }
console.log(`all ${n} polis lock checks passed`);
