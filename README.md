# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/wl0502749-code/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/wl0502749-code/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Nothing here trades for real: no real SOL, no real tokens, no wallet, no network.

## Strategy — surge and trail

Fresh pump.fun curves either catch a bid within minutes of creation or bleed out, so the bot only buys a young coin that has already proved demand:

- **Entry:** coin younger than ~3,600 slots (~24 min), at least 3 trades, price up ≥ 15% from its first print, and buy volume outweighing sell volume. One 0.05 SOL buy per coin, at most 5 coins open at once. Slippage is capped tight at 200 bps — a fill that ran away from the decision price is rejected rather than chased.
- **Exit:** take-profit at +25%, hard stop-loss at −15%, a trailing stop once the trade is up 10% (sell on a 10% pullback from the peak), and a maximum hold of ~3,600 slots (~24 min).

All price comparisons use exact bigint cross-multiplication on the bonding-curve reserves (virtual quote per virtual token) — no floats, no randomness, no clock, no network — so two runs of the bot produce identical action logs.

## Run it

```sh
node main.ts
```

The grader runs `node main.ts` with this directory mounted at `/bot`; the bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout through the vendored SDK shim in `vendor/makefun-bot.ts`. Requires Node 22.18+ (the grader uses Node 22.23.4).

## Layout

- `main.ts` — the bot: entry/exit rules, nothing else.
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim, vendored unchanged.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4rzbqkgp&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
