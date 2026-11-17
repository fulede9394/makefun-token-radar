// Token Launch Radar — an original entry for make.fun competition token-radar-01.
//
// What it does: reads the sealed DefiLlama snapshot (758 protocols, as of
// 2026-11-14), ranks the 200 pre-token protocols most likely to be worth a
// launch, writes the board to /output/board.json, the dashboard's data to
// /output/data.js, and copies dashboard/ and screenshots/ into /output, then
// writes /output/dossier.json with the vendored make.fun library.
//
// The value model (all from the snapshot's own figures, never a list of
// names): a protocol's implied token value is its TVL, scaled by how fast
// that TVL grew over the last 7 days and by how long it has run with no
// token recorded, times a launch multiple of 0.35 — the share of TVL a new
// token's implied value is taken to be worth. Eligibility follows the
// watchlist's own rule: the protocol records no token (gecko_id and symbol
// both null) and is not a bridge, a centralised exchange, a liquid-staking
// product or a versioned deployment of something else.
//
// Run it (outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for
// /output):
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4 * 1024 * 1024 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The snapshot's date, the anchor every age is measured from. */
const AS_OF = '2026-11-14';
const AS_OF_MS = Date.parse(`${AS_OF}T00:00:00Z`);
const DAY_MS = 86_400_000;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

// ---------------------------------------------------------------- snapshot

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

function parseSnapshot(text: string): Snapshot {
  const data = JSON.parse(text) as Snapshot;
  if (!Array.isArray(data.protocols) || !Array.isArray(data.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return data;
}

// ---------------------------------------------------------------- the model

/** Categories the watchlist rule treats as a wrapped, staked or bridged product. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names the watchlist rule treats as a product of that exchange. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name ending in a version marker (a space followed by V2, v2, 2.0 or the like). */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol records no token when both of these are null. */
function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/**
 * The watchlist's own eligibility rule, applied to any protocol: it records
 * no token and is not a bridge, a centralised exchange, a liquid-staking
 * product or a versioned deployment of another protocol. The rule reads the
 * snapshot's own fields — category and name — never a list of slugs.
 */
function isLaunchCandidate(p: Protocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (EXCHANGE_NAMES.some((name) => p.name.startsWith(name))) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  return true;
}

/** Days from the protocol's first tracking day to the snapshot date; 365 when unreported. */
function ageDays(p: Protocol): number {
  if (p.listed_at === null) return 365;
  const listed = Date.parse(`${p.listed_at}T00:00:00Z`);
  if (Number.isNaN(listed)) return 365;
  return Math.max(0, Math.round((AS_OF_MS - listed) / DAY_MS));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The implied value of a launch, in whole dollars.
 *
 *   implied = TVL x 0.35 x growth x tenure
 *
 * 0.35 is the launch multiple: the share of a protocol's TVL its token is
 * taken to be worth on launch. growth is the 7-day TVL change, clamped to
 * -40%..+120% and halved, so a fast grower is worth up to 1.6x and a fast
 * shrinker down to 0.8x (no change reported counts as flat). tenure is how
 * long the protocol has run with no token recorded, up to 4 years, worth up
 * to 1.4x: the longer it has run without one, the more launch value has
 * built up behind it.
 */
function impliedValue(p: Protocol): number {
  const change = p.change_7d === null ? 0 : p.change_7d;
  const growth = 1 + clamp(change, -40, 120) / 200;
  const tenure = 1 + (Math.min(ageDays(p), 1460) / 1460) * 0.4;
  return Math.max(1, Math.round(p.tvl_usd * 0.35 * growth * tenure));
}

// ---------------------------------------------------------------- farm plans

/** Which family of actions a category calls for. */
function familyFor(category: string | null): string {
  switch (category) {
    case 'Dexs':
    case 'Liquidity Manager':
      return 'dex';
    case 'Lending':
    case 'Uncollateralized Lending':
    case 'Collateral Markets':
      return 'lending';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farm':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Leveraged Farming':
      return 'yield';
    case 'Derivatives':
    case 'Options':
    case 'Options Vault':
    case 'Basis Trading':
    case 'Interest Rate Derivatives':
    case 'Synthetics':
      return 'derivatives';
    case 'RWA':
    case 'Token Locker':
      return 'rwa';
    case 'CDP':
    case 'CDP Manager':
    case 'Collateral Management':
    case 'Stablecoin Issuer':
    case 'Algo-Stables':
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Wrapper':
      return 'stable';
    case 'Launchpad':
      return 'launchpad';
    case 'Chain':
    case 'Decentralized BTC':
    case 'Anchor BTC':
      return 'chain';
    case 'Prediction Market':
      return 'prediction';
    case 'Payments':
    case 'Crypto Card Issuer':
    case 'CeDeFi':
      return 'payments';
    case 'Privacy':
      return 'privacy';
    case 'Indexes':
      return 'indexes';
    case 'Insurance':
      return 'insurance';
    case 'NFT Marketplace':
      return 'nft';
    case 'OTC Marketplace':
      return 'otc';
    default:
      return 'generic';
  }
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

/**
 * Four concrete farm steps for one protocol, written from its own category,
 * its first chain and its name. Each step says what to do, roughly what it
 * costs and how long it takes — never a slogan. Amounts are the reader's own
 * size to start with; nothing here is financial advice and a launch is never
 * promised.
 */
function farmSteps(p: Protocol): string[] {
  const name = p.name;
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const cat = p.category ?? 'DeFi';
  switch (familyFor(p.category)) {
    case 'dex':
      return [
        `Swap ${money(100)}–${money(250)} of a major asset (ETH or a stablecoin) for another token ${name} lists on ${chain}, in a single trade. It takes about 2 minutes and costs roughly ${money(1)}–${money(3)} in gas.`,
        `Add ${money(100)}–${money(250)} of liquidity to one of ${name}'s busiest pools on ${chain} — a stablecoin pair if you want low impermanent loss — and leave it in for at least 2 weeks so the position earns fees.`,
        `Make 3–5 more swaps on ${name} over the next month, ${money(25)}–${money(100)} each on different days, so the activity reads as regular use rather than a single visit.`,
        `Keep the same wallet funded with ${money(5)}–${money(10)} of ${chain}'s gas token and check ${name}'s app weekly; if it opens a points page, connect that same wallet so your trading history is the one it sees.`,
      ];
    case 'lending':
      return [
        `Supply ${money(200)}–${money(500)} of a stablecoin to ${name}'s lending market on ${chain} and leave it supplied for at least 2 weeks. The deposit takes about 2 minutes and costs roughly ${money(1)}–${money(4)} in gas.`,
        `Borrow a small amount — ${money(50)}–${money(100)} — against that supply, hold the loan for a week, then repay it in full, so the wallet shows both sides of the market. Keep the loan under half the supply so it is never at risk of liquidation.`,
        `Repeat the supply-and-borrow cycle once more the following month with a different asset ${name} supports on ${chain}, ${money(100)}–${money(200)} each time.`,
        `Watch ${name}'s borrow rates weekly for a month; if a new market or collateral type opens on ${chain}, be an early supplier with ${money(50)}–${money(100)} in the first week.`,
      ];
    case 'yield':
      return [
        `Deposit ${money(200)}–${money(500)} into one of ${name}'s ${cat} vaults on ${chain} and leave it for at least 3 weeks so the position compounds. The deposit takes about 3 minutes and costs roughly ${money(1)}–${money(5)} in gas.`,
        `Claim or compound the yield once a week for a month — each claim is a transaction of about a minute and ${money(1)}–${money(3)} in gas — rather than leaving everything untouched.`,
        `Split a second deposit of ${money(100)}–${money(200)} into a different vault or strategy ${name} runs on ${chain}, so the wallet touches two of its products instead of one.`,
        `Check ${name}'s vault list every week for a month; when a new vault opens on ${chain}, deposit ${money(50)}–${money(100)} within its first week, when early depositors are usually the ones a launch remembers.`,
      ];
    case 'derivatives':
      return [
        `Open a small perpetual or options position on ${name} on ${chain} — ${money(50)}–${money(150)} of notional value, low leverage (2x or less) — and close it within a few days. The two trades take a few minutes each and cost roughly ${money(1)}–${money(4)} in gas.`,
        `Place 2–3 more trades of ${money(25)}–${money(75)} over the next month on different days, using a different market each time, so the wallet shows repeated use of the exchange.`,
        `If ${name} offers a test or paper market, run a practice trade there first to learn the interface before risking real funds; never trade more than you can afford to lose.`,
        `Keep ${money(5)}–${money(10)} of ${chain}'s gas token in the trading wallet and review open positions at least twice a week — a leveraged position left unwatched can be liquidated.`,
      ];
    case 'rwa':
      return [
        `Buy or mint ${money(100)}–${money(300)} of ${name}'s tokenised asset on ${chain} and hold it for at least a month. The purchase takes a few minutes and costs roughly ${money(1)}–${money(5)} in gas.`,
        `If ${name} lets the asset be used elsewhere, deposit ${money(50)}–${money(100)} of it as collateral or into a vault it supports, so the wallet shows the asset being used rather than sitting idle.`,
        `Read ${name}'s redemption terms before buying — check the minimum hold, any lock-up and the fee to redeem — and keep a note of the next distribution or payout date.`,
        `Make a second purchase of ${money(50)}–${money(100)} a month later, on a different day, to show continued use of the product.`,
      ];
    case 'stable':
      return [
        `Mint ${money(100)}–${money(300)} of ${name}'s stable asset on ${chain} against collateral you already hold, and keep the position over-collateralised (at least 150% of what you mint). Minting takes about 3 minutes and costs roughly ${money(1)}–${money(4)} in gas.`,
        `Use ${money(50)}–${money(100)} of the minted asset in a second protocol — a swap, a deposit or a payment — so the stable asset circulates instead of sitting in the wallet.`,
        `Repay half the minted amount after 2 weeks and mint it again the following week, so the wallet shows an active borrowing cycle rather than a single mint.`,
        `Check ${name}'s collateral ratio and stability fee weekly; if the fee drops or a new collateral type opens on ${chain}, move ${money(50)}–${money(100)} into it within the first week.`,
      ];
    case 'launchpad':
      return [
        `Register on ${name}'s launchpad on ${chain} and complete whatever verification it asks for — usually a wallet connection and a profile, about 10 minutes — then stake or hold the ${money(50)}–${money(100)} it requires for access.`,
        `Join the next sale or allocation ${name} runs with a small ticket of ${money(25)}–${money(75)} and hold the allocation for at least a month rather than selling on day one.`,
        `Vote or take part in the community rounds ${name} opens between sales, at least twice in the next month; each takes a few minutes.`,
        `Keep the access stake in place for 2–3 months and check the launch calendar weekly so you do not miss a sale window, which is usually open for only 24–72 hours.`,
      ];
    case 'chain':
      return [
        `Bridge ${money(100)}–${money(300)} of a major asset onto ${chain} through ${name}'s official bridge and hold it there for at least 2 weeks. The bridge takes 5–30 minutes and costs roughly ${money(2)}–${money(10)} in fees.`,
        `Use the bridged funds in 2–3 different apps on ${chain} over the next month — a swap, a deposit and a payment — ${money(25)}–${money(100)} each, so the wallet is active on the chain rather than just passing through.`,
        `If ${chain} has a native staking or delegation option through ${name}, stake ${money(50)}–${money(100)} for at least a month and check the rewards weekly.`,
        `Keep ${money(5)}–${money(10)} of ${chain}'s gas token in the wallet at all times so a transaction never fails for lack of gas.`,
      ];
    case 'prediction':
      return [
        `Place a first prediction on ${name} on ${chain} with ${money(10)}–${money(50)} on a market you have actually read, and let it resolve rather than selling out early. Placing it takes about 2 minutes.`,
        `Trade 3–5 more markets over the next month, ${money(10)}–${money(25)} each, across different topics, so the wallet shows breadth of use.`,
        `Provide ${money(50)}–${money(100)} of liquidity to one of ${name}'s markets if it offers it, and leave it in until that market resolves.`,
        `Review resolved markets weekly and keep a simple note of wins and losses; never chase a loss with a bigger stake than the ${money(50)} limit above.`,
      ];
    case 'payments':
      return [
        `Make a first real payment of ${money(25)}–${money(100)} through ${name} on ${chain} — a purchase, a transfer or a card load — and confirm it settles. It takes a few minutes and costs roughly ${money(1)}–${money(3)} in fees.`,
        `Repeat with 2–3 more payments over the next month, ${money(25)}–${money(75)} each, on different days, so the wallet shows steady use of the rails.`,
        `If ${name} offers a rewards or cashback balance, claim it once a month and keep the claimed amount in the same wallet.`,
        `Check ${name}'s supported assets and fees weekly; when a new payment route opens on ${chain}, send a first ${money(25)} test payment through it within the first week.`,
      ];
    case 'privacy':
      return [
        `Make a first private transaction of ${money(50)}–${money(150)} through ${name} on ${chain}, following its own guide step by step, and confirm it settles. Allow 10–30 minutes for the first run and roughly ${money(1)}–${money(5)} in fees.`,
        `Repeat with 2–3 more transactions over the next month, ${money(25)}–${money(75)} each, using different amounts and times so the pattern is not mechanical.`,
        `Read ${name}'s anonymity notes before each run — minimum and maximum amounts, waiting times and what not to do — and never reuse the same deposit and withdrawal addresses.`,
        `Keep a private note of each transaction's timing and amount; privacy tools need care, and a mistake is hard to undo.`,
      ];
    case 'indexes':
      return [
        `Buy ${money(100)}–${money(300)} of ${name}'s index on ${chain} and hold it for at least a month. The purchase takes a few minutes and costs roughly ${money(1)}–${money(4)} in gas.`,
        `Rebalance or add ${money(50)}–${money(100)} once a month for the next 2 months, so the wallet shows continued use rather than a single buy.`,
        `Read the index's composition before buying — which assets it holds and their weights — and check it again monthly, since rebalances change what you own.`,
        `If ${name} opens a new index on ${chain}, buy a first ${money(50)} position within its first week.`,
      ];
    case 'insurance':
      return [
        `Buy cover of ${money(100)}–${money(300)} through ${name} on ${chain} for a protocol or asset you already use, for at least a month of cover. The purchase takes about 5 minutes and costs roughly ${money(1)}–${money(4)} in gas.`,
        `Read the policy wording before buying — what events are covered, the excess and how a claim is filed — and keep the policy details in one place.`,
        `Renew or extend the cover when it lapses rather than letting it drop, and file any claim promptly with the evidence the policy asks for.`,
        `If ${name} opens cover for a new protocol on ${chain}, buy a first ${money(50)} policy within its first week.`,
      ];
    case 'nft':
      return [
        `Buy or list one item on ${name} on ${chain} for ${money(25)}–${money(100)} and complete the sale or purchase in full. A listing takes a few minutes and costs roughly ${money(1)}–${money(3)} in gas.`,
        `Make 2–3 more trades over the next month, ${money(25)}–${money(75)} each, on different collections, so the wallet shows repeated use of the marketplace.`,
        `If ${name} runs creator or collector rewards, claim them once a month with the same wallet that traded.`,
        `Check ${name}'s new listings weekly; when a collection you follow opens, be an early buyer with a ${money(25)}–${money(50)} first trade.`,
      ];
    case 'otc':
      return [
        `Complete a first OTC trade of ${money(100)}–${money(500)} through ${name} on ${chain}, using its escrow or settlement flow exactly as its guide describes. Allow a day for settlement and roughly ${money(2)}–${money(10)} in fees.`,
        `Repeat with a second trade of ${money(100)}–${money(250)} the following month, with a different counterparty or asset.`,
        `Keep a record of every trade — asset, amount, counterparty and settlement time — and never settle outside the escrow flow ${name} provides.`,
        `Check ${name}'s listed desks and assets weekly; when a new asset opens on ${chain}, make a first ${money(50)}–${money(100)} trade within its first week.`,
      ];
    default:
      return [
        `Use ${name}'s ${cat} product on ${chain} with a first position of ${money(100)}–${money(250)} and leave it open for at least 2 weeks. The first transaction takes a few minutes and costs roughly ${money(1)}–${money(5)} in gas.`,
        `Come back and use it again 2–3 times over the next month, ${money(25)}–${money(100)} each time on different days, so the wallet shows repeated use rather than a single visit.`,
        `If ${name} opens a new feature or market on ${chain}, try it early with ${money(50)}–${money(100)} within its first week.`,
        `Keep ${money(5)}–${money(10)} of ${chain}'s gas token in the wallet and check ${name}'s app weekly for new features, points or rewards tied to the same wallet.`,
      ];
  }
}

// ---------------------------------------------------------------- the board

interface BoardRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  watchlist: boolean;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/**
 * Build the 200-row board: every watchlist slug, plus the 160 highest-valued
 * other launch candidates, ranked by implied value. Values are made strictly
 * decreasing down the ranks so the order is a real ranking, not a tie.
 */
function buildBoard(snapshot: Snapshot): BoardRow[] {
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(isLaunchCandidate);
  const scored = candidates.map((p) => ({ p, value: impliedValue(p) }));
  scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));

  const picked: { p: Protocol; value: number }[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (watchlist.has(s.p.slug)) {
      picked.push(s);
      seen.add(s.p.slug);
    }
  }
  for (const s of scored) {
    if (picked.length >= 200) break;
    if (seen.has(s.p.slug)) continue;
    picked.push(s);
    seen.add(s.p.slug);
  }
  if (picked.length < 200) {
    throw new Error(`board: only ${picked.length} launch candidates, need 200`);
  }

  picked.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  let previous = Number.POSITIVE_INFINITY;
  return picked.map((s, i) => {
    let value = Math.min(s.value, previous - 1);
    if (value < 1) value = 1;
    previous = value;
    return {
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: ageDays(s.p),
      watchlist: watchlist.has(s.p.slug),
      rank: i + 1,
      implied_value_usd: value,
      farm_steps: farmSteps(s.p),
    };
  });
}

/** The gate's own shape checks, run here so a bad board fails loudly. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, not 100 to 4000`;
  const slugs = new Set<string>();
  const ranks = new Set<number>();
  let previous = Number.POSITIVE_INFINITY;
  let allEqual = board.length > 1;
  const first = board[0]?.implied_value_usd;
  for (const row of board) {
    if (slugs.has(row.slug)) return `slug ${row.slug} appears twice`;
    slugs.add(row.slug);
    if (!snapshot.protocols.some((p) => p.slug === row.slug)) return `slug ${row.slug} is not in the snapshot`;
    if (row.name.trim() === '') return `row ${row.slug} has no name`;
    if (!Number.isInteger(row.rank) || row.rank < 1) return `row ${row.slug} has a bad rank`;
    ranks.add(row.rank);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1) {
      return `row ${row.slug} has a bad implied value`;
    }
    if (row.implied_value_usd > previous) return `implied value rises at rank ${row.rank}`;
    previous = row.implied_value_usd;
    if (row.implied_value_usd !== first) allEqual = false;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug} has ${row.farm_steps.length} farm steps, not 3 to 12`;
    }
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) {
        return `row ${row.slug} has a farm step of ${trimmed.length} characters, not 20 to 600`;
      }
    }
  }
  for (let r = 1; r <= board.length; r++) {
    if (!ranks.has(r)) return `rank ${r} is missing`;
  }
  if (allEqual) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data.js: the board rows the page renders, as one script. */
function dataScript(board: BoardRow[]): string {
  const payload = {
    as_of: AS_OF,
    model:
      'implied = TVL x 0.35 x growth x tenure; growth from the 7-day TVL change (clamped -40%..+120%, halved); tenure from days tracked with no token recorded (up to 4 years, up to 1.4x).',
    rows: board.map((r) => ({
      slug: r.slug,
      name: r.name,
      cat: r.category,
      chains: r.chains,
      tvl: r.tvl_usd,
      chg: r.change_7d,
      age: r.age_days,
      wl: r.watchlist,
      rank: r.rank,
      val: r.implied_value_usd,
      steps: r.farm_steps,
    })),
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}

// ---------------------------------------------------------------- main

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const board = buildBoard(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(board));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

const dossier = buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: DASHBOARD_CAPS,
});
writeFileSync(join(out, 'dossier.json'), dossier);
process.stdout.write(`token radar: ${board.length} rows, top ${board[0]!.name} at $${board[0]!.implied_value_usd.toLocaleString('en-US')}\n`);
