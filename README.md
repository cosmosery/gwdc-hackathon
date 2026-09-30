# Settle · GasFree Batch Payments

## Current deployment and wallet support (2026-09-30)

- **Frontend:** https://settle-payroll-web.vercel.app
- **Engine API:** https://tron-gasfree-batch-nile-probe.vercel.app
- Enter your engine access token in Connection settings on the hosted site. The token is held only in the current tab’s memory and must be entered again after a refresh. Do not include secrets in documentation, URLs, or public bundles.

### Currently available manual flow

Upload and review CSV → get a quote → prepare the batch Vault address → **manually approve the transfer in TronLink → GasFree → Send** → verify the Vault balance → **Start payouts** → confirm individual transactions and reconcile results.

Funds originate from the user’s GasFree account. The connected ordinary TRON address (EOA) identifies the owner of that GasFree account. The website does not request a PermitTransfer signature. Manual deposit verification currently checks the Vault balance, so **it does not verify that the funds originated from GasFree**. A missing `depositTxId` does not by itself indicate a failed deposit.

Start payouts sends `{"mode":"direct"}` and a batch-specific `Idempotency-Key` to `POST /batches/:batchId/execute`. It does not include `authorization` or `signature`. The server checks the current on-chain balance and, if sufficient, accepts the batch as PROCESSING and starts payouts. An insufficient-balance 400 response is not successful execution. `/resume` does not replace the initial payout request. The same execution key is reused after a lost response or page refresh.

### Integration with wallets that support third-party signing

With a compatible wallet, the dApp can construct PermitTransfer typed data → **the user approves and signs in the wallet** → the dApp receives the signature → the backend submits it to the GasFree Provider → funds move from the GasFree account to the Vault → the engine executes payouts. Automation here means **connecting signature delivery, submission, and execution after approval**. It does not mean signing automatically with a private key without user approval. The owner EOA controlling the GasFree account signs the authorization.

The official GasFree documentation describes this signing and Provider submission flow: https://docs.gasfree.io/ . However, TronLink rejected the external request in our tests with `TronLink does not support permit transfer requests from a third party`. **Protocol support and wallet support for external requests are separate.** This does not mean every wallet is incompatible, nor that we have already validated another wallet.

The deployed frontend currently uses the manual path only. Automatic integration with a compatible wallet requires additional integration and validation; changing wallets does not automatically switch the current interface to a signing mode. The backend’s compatibility with signed execute requests is distinct from the frontend’s currently available features.

The fee buffer in the manual flow is an estimated budget, not an enforced PermitTransfer `maxFee`. Check the actual fee in TronLink’s approval screen. Payout success is determined by each recipient’s confirmed status, not by an accepted execution request (200).

**[Open the frontend →](https://settle-payroll-web.vercel.app)** · [Engine API](https://tron-gasfree-batch-nile-probe.vercel.app) · [Current integration status](docs/CURRENT_INTEGRATION_KO.md)

Review a CSV payment list on TRON Nile, fund a batch-specific vault from the user’s GasFree account, and track recipient-level payout results through the engine.

The current web flow is **CSV review → fee quote → vault preparation → manual transfer in TronLink GasFree → Start payouts → results and reconciliation**. The website does not request a PermitTransfer signing popup. After funding, it calls `POST /batches/:batchId/execute` with `{ "mode": "direct" }` and no signature. This requires server support for that execution mode and sufficient relayer resources.

To use engine features on the public site, enter your issued token under **Open another batch · connection settings → Engine access token**. The token remains only in the current tab’s memory and must be entered again after refreshing. Tokens are not included in the repository or deployment bundle. Set TronLink in Chrome to Nile and prepare a balance in your GasFree account.

The frontend deployment project is `settle-payroll-web`, with source code in `web/`. Run `cd web` followed by `npx vercel --prod` to deploy. GitHub automatic deployment has not yet been connected, so pushing alone does not deploy the site. The following sections describe the engine’s original proof-of-concept design and development workflow.

## Q1. What to verify on Nile

The repository’s proof-of-concept script runs in this order:

1. Query the Nile GasFree API for supported tokens, Providers, the user’s GasFree account nonce, and fees.
2. The relayer deploys `BatchFactory`. The Factory deploys the `BatchExecutor` implementation once. For each batch, it derives a salt from the CSV Merkle root, total amount, token, refund address, expiry, and batchId, then deploys and initializes a lightweight clone using CREATE2. Read the deployed clone’s state and compare it with the signing message.
3. Sign TIP-712 `PermitTransfer` **once** with the user key. The `receiver` is the deployed BatchExecutor. Submit it to the official Nile Provider’s `POST /nile/api/v1/gasfree/submit` endpoint and poll by traceId until `SUCCEED`.
4. Verify that USDT `balanceOf(BatchExecutor)` is at least the required amount. The relayer calls `execute`, checks the recipient’s balance increase and `paid(0)`, and verifies that executing the same row again is rejected.

The proof of concept succeeds only when **Provider acceptance, on-chain funding, payout, and duplicate-payment rejection** are all verified. Whether the Provider actually permits a custom contract recipient beyond address-format validation cannot be established before this test.

To run the API, deploy the Factory once and set the returned address as `NILE_FACTORY_ADDRESS` in `.env`. `npm run deploy:factory` consumes Nile TRX. Subsequent `/batches` operations deploy only per-batch clones using the same Factory and implementation contract. A Factory address from the previous full-code deployment approach cannot be reused.

```bash
npm install
npm run check
cp .env.example .env
# Fill in .env and fund the GasFree account on Nile with test USDT.
# Fund the relayer with Nile TRX for deployment and execution.
node --env-file=.env scripts/nile-probe.cjs
```

Configure `.env` with a Nile-only user key, a separate relayer key, an API Key/Secret from the [GasFree Developer Center](https://developer.gasfree.io/), the Nile USDT address supported by the official Provider, and a test recipient address. The test user key is used only for GasFree Permit signing. In an integration with a wallet supporting third-party signing, the user approves the signature in the browser and the private key is never sent to the server. The current TronLink web path uses the manual flow described above. The test GasFree account needs a balance covering `amount + maxFee`. The generated `.env` is excluded from Git. Deployment and transfer tests consume Nile assets and relayer TRX.

If a GasFree call times out, **do not immediately resubmit the same signature with a new requestId**. First check the traceId and account nonce/balance. After `SUCCEED`, verify the deposit balance and proceed to payouts. After a payout timeout, check `paid(index)` and the on-chain transaction result. The on-chain `paid` state prevents double payment. The proof-of-concept script is intended for a single happy-path run; running it again deploys a new batch.

## Q2. Merkle root versus storing the full list

| Aspect | Merkle root | Full list stored in the contract |
| --- | --- | --- |
| Deployment data | Fixed-size data such as root and total | Grows with the number of rows |
| Per-row execution | Submit `index`, recipient, amount, and proof; verify hashes | Submit only `index` and read the stored row |
| CSV verification | Browser must compute the root and total from the source | Browser must verify the full list stored at deployment |
| Scale | Suitable for tens to hundreds of rows | Simpler implementation for very small fixed lists |
| Cost profile | Lower deployment cost, with per-row proof verification cost | Higher deployment storage cost, with simpler per-row execution |

The Merkle approach is recommended for 100-row batches. Storing the full list requires finalizing the list **before deployment** and having the user independently calculate the address to achieve the same signing security model. In both approaches, the browser must verify the creation code, factory address, constructor arguments, row order, and amount units. Displaying a `CREATE2` address alone does not automatically bind it to the CSV.

## Q3. Minimal contract

The `BatchExecutor` implementation is deployed once, with a clone created for each batch. The Factory calls `initialize()` to set the clone’s `token`, `paymentsRoot`, `totalAmount`, `refundAddress`, and `expiry` exactly once. Mutable state consists of `paid[index]`, `paidAmount`, and a reentrancy lock. The payout and refund functions are `execute(index, recipient, amount, proof)` and `refund()`. `execute` checks expiry, funding, proof, duplicates, and the total cap, then records `paid[index]` before calling TRC-20 `transfer`. Because Nile USDT returns `false` even for successful transfers, actual sender and recipient balance changes are checked. After expiry, `refund` returns the unpaid balance to the fixed user address. Excess tokens received after all payouts are complete can also be returned to that address. Refunds are separate from payments to the intended recipients and must be clearly distinguished in the user interface.

A Merkle leaf is `keccak256(abi.encode(uint256 index, address recipient, uint256 amount))`. Addresses are encoded as internal 20-byte TVM addresses. Paired hashes are sorted by byte order before calculating `keccak256(left || right)`. An unpaired final node is carried unchanged to the next level. The browser, server, and contract must use the same rules.

The contract itself **does not prove that the amounts committed in the root sum to `totalAmount`**. The user’s browser must parse the CSV and verify unique indices, recipients, positive amounts, the total, and the root. The Factory includes batch settings and batchId in the salt and creates and initializes the clone in one transaction. The official Factory address and implementation code must also be pinned, and the actual deployed code and initialized state verified, to prevent the server from presenting a contract with different semantics. In this signing design, GasFree signing occurs **after BatchExecutor deployment is verified**. Remaining funds may be refunded if payouts are not completed before expiry, so allow sufficient time for relayer processing. TRON/Nile validation, fee measurement, and security review are required before production use.

## Current verification scope

`npm run check` uses a mock token on a local EVM to test CREATE2 deployment, rejection of payouts before funding, rejection of modified recipients or amounts, successful payouts, duplicate-payment rejection, and refunds after expiry. The TRON CREATE2 address formula is calculated separately. Local EVM results do not establish TRON TVM behavior or official GasFree Provider policy. Start the Nile test with `node --env-file=.env scripts/nile-probe.cjs`. See [NILE_RESULTS.md](NILE_RESULTS.md) for the September 28, 2026 test results and limitations.

Official references: [GasFree Developer Documentation](https://docs.gasfree.io/), [GasFree JS SDK](https://github.com/gasfreeio/gasfree-sdk-js/blob/main/src/TronGasFree.ts), [TRON CREATE2 differences](https://developers.tron.network/re/docs/migrating-eth-contracts-to-tron), [TronWeb TIP-712 signing](https://tronweb.network/docu/docs/6.0.0/API%20List/trx/signTypedData/).
