// Surge-and-trail paper bot for the pump.fun replay sprint.
//
// Paper money only: this bot never touches real SOL, never signs a real
// transaction, and only answers the replay harness on stdin/stdout. It trades
// the 10 SOL of paper capital the harness grants, at most 5 coins at a time.
//
// Idea: fresh pump.fun curves either catch a bid within minutes of creation
// or bleed out. The bot only buys a young coin that has already proved
// demand — its price is up at least 15% from its first print and buy volume
// outweighs sell volume — then manages the position with a hard take-profit,
// a hard stop-loss, a trailing stop once the trade is working, and a maximum
// holding age. Every decision is a pure function of the batches seen so far:
// no randomness, no clock, no network, so two runs agree byte for byte.
// Slippage is kept tight (200 bps): on a fast curve a fill far from the
// decision price is usually a buy at the top of a spike, so the bot would
// rather have the order rejected than filled badly.
//
// Prices are bonding-curve prices: virtual_quote_reserves per
// virtual_token_reserves. All comparisons are done with bigint
// cross-multiplication, never floats, so the arithmetic is exact.
//
// Run by the grader as `node main.ts` with this directory mounted at /bot.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BuyInput,
  type Curve,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- Tunables (all in lamports / slots / basis points of price) -----------------

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // skip dust: need a 0.01 SOL cap
const MAX_SLIPPAGE_BPS = 200; // tight: reject a fill that ran away, don't chase it
const MAX_ENTRY_AGE_SLOTS = 3_600; // only coins younger than ~24 min
const MIN_TRADES_TO_ENTER = 3; // ignore one-print noise
const MAX_HOLD_SLOTS = 3_600; // ~24 min, then exit whatever the price does

// Entry: price up >= 15% from the first print (x23/20), buys beating sells.
const SURGE_NUM = 23n;
const SURGE_DEN = 20n;
// Take-profit: price >= entry x 1.25 (x5/4).
const TAKE_PROFIT_NUM = 5n;
const TAKE_PROFIT_DEN = 4n;
// Stop-loss: price <= entry x 0.85 (x17/20).
const STOP_LOSS_NUM = 17n;
const STOP_LOSS_DEN = 20n;
// Trailing stop: once price has reached entry x 1.1 (x11/10), a fall back to
// 90% of the peak (x9/10) sells.
const TRAIL_ARM_NUM = 11n;
const TRAIL_ARM_DEN = 10n;
const TRAIL_GIVEBACK_NUM = 9n;
const TRAIL_GIVEBACK_DEN = 10n;

/** Price as a (quote, token) reserve pair; comparisons cross-multiply. */
type Price = { q: bigint; t: bigint };

function priceOf(curve: Curve): Price {
  return { q: curve.virtual_quote_reserves, t: curve.virtual_token_reserves };
}

/** Is price a >= price b * num/den? Exact bigint comparison, no floats. */
function atLeast(a: Price, b: Price, num: bigint, den: bigint): boolean {
  return a.q * b.t * den >= b.q * a.t * num;
}

/** Is price a <= price b * num/den? */
function atMost(a: Price, b: Price, num: bigint, den: bigint): boolean {
  return a.q * b.t * den <= b.q * a.t * num;
}

interface CoinNote {
  firstPrice: Price;
  createdSlot: number;
  buySol: bigint;
  sellSol: bigint;
  trades: number;
  decided: boolean; // bought once, or aged out of the entry window
}

interface OpenTrade {
  entryPrice: Price;
  peakPrice: Price;
  entrySlot: number;
}

const notes = new Map<string, CoinNote>();
const open = new Map<string, OpenTrade>();

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // ---- Fold this batch's events into per-coin notes. ----
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = state.curves.get(e.mint);
        if (curve !== undefined && !notes.has(e.mint)) {
          notes.set(e.mint, {
            firstPrice: priceOf(curve),
            createdSlot: e.slot,
            buySol: 0n,
            sellSol: 0n,
            trades: 0,
            decided: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const note = notes.get(e.mint);
        if (note !== undefined) {
          note.trades += 1;
          if (e.is_buy) note.buySol += BigInt(e.sol_amount);
          else note.sellSol += BigInt(e.sol_amount);
        }
      } else {
        // CompleteEvent: the curve is done; forget the coin.
        notes.delete(e.mint);
        open.delete(e.mint);
      }
    }

    // ---- Exits first, so a sale frees a slot and cash for entries. ----
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      const trade = open.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (trade === undefined) continue; // safety: never sell what we did not open
      const now = priceOf(curve);
      // Ratchet the peak, then test the exits.
      if (now.q * trade.peakPrice.t > trade.peakPrice.q * now.t) {
        trade.peakPrice = now;
      }
      const armed = atLeast(trade.peakPrice, trade.entryPrice, TRAIL_ARM_NUM, TRAIL_ARM_DEN);
      const giveback =
        armed && atMost(now, trade.peakPrice, TRAIL_GIVEBACK_NUM, TRAIL_GIVEBACK_DEN);
      const takeProfit = atLeast(now, trade.entryPrice, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN);
      const stopLoss = atMost(now, trade.entryPrice, STOP_LOSS_NUM, STOP_LOSS_DEN);
      const stale = state.slot - trade.entrySlot > MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || giveback || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        open.delete(mint);
      }
    }

    // ---- Entries: young coins with a proved surge and buy pressure. ----
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
    }
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const note = notes.get(mint);
      if (note === undefined || note.decided) continue;
      if (state.positions.has(mint) || pendingBuy.has(mint)) {
        note.decided = true;
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        note.decided = true;
        continue;
      }
      // Age out: a coin that never surged while young never gets bought.
      if (state.slot - note.createdSlot > MAX_ENTRY_AGE_SLOTS) {
        note.decided = true;
        continue;
      }
      if (note.trades < MIN_TRADES_TO_ENTER) continue;
      if (note.buySol <= note.sellSol) continue; // need net buying, not churn
      const now = priceOf(curve);
      if (!atLeast(now, note.firstPrice, SURGE_NUM, SURGE_DEN)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) {
        // No room right now; keep the coin undecided so a later batch can
        // still take it while it is young.
        continue;
      }
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      note.decided = true;
      open.set(mint, { entryPrice: now, peakPrice: now, entrySlot: state.slot });
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
