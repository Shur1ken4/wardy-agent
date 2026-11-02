# Wardy Network registry contract

A tiny NEAR contract that anchors the Merkle root of the Wardy Network report feed. Created from the official
`cargo near new` template, with its auction example replaced and unused test dependencies removed.

| Method | Who | What |
|---|---|---|
| `new(owner)` | deployer | Sets the owner |
| `add_reporter(account_id)`, `remove_reporter(account_id)` | owner | Manages who may anchor |
| `anchor_root(root, count, uri)` | registered reporter | Records a root. `count` can't shrink, and the same `count` can only repeat the same root |
| `get_latest_root()`, `is_reporter(account_id)`, `get_reporters()`, `get_owner()` | anyone | Views |

Payee data stays in the off-chain feed. Only the root goes on-chain.

```bash
npm run contract:test
```

```bash
npm run contract:build
```

The deployed testnet address is in [`config/registry.testnet.json`](../../config/registry.testnet.json).
