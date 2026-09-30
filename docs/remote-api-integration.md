> 현재 흐름과 최신 원격 API 재검증은 [CURRENT_INTEGRATION_KO.md](CURRENT_INTEGRATION_KO.md)를 기준으로 확인하세요. 아래 내용은 작업 시점의 이력을 포함합니다.

# Remote Nile engine connection

The UI uses live payments by default and has no demo mode switch.

Live CSV testing is intentionally constrained in the client to 1–20 recipient
rows, at most 1 USDT per row, and at most 10 USDT principal per batch. The
downloadable small-test CSV contains three 0.01–0.03 USDT rows addressed to the
configured sender wallet. These limits are client-side test safeguards, not an
engine/API policy.

Run `npm run dev:web`. The loopback API bridge reads `ENGINE_API_URL` and
`API_BEARER_TOKEN` from the ignored `.env.frontend.local`, overriding the local
engine credentials for the frontend process only. Vite receives no API or wallet
secrets. The current remote endpoint is `https://tron-gasfree-batch-nile-probe.vercel.app`.

On 2026-09-30 the frontend was switched from the previous IP-based endpoint to
this Vercel endpoint, preserving the existing bearer credential. Health returned
200. The previously verified batch `b_1790707208455_db092e92` returned 404 on the
new deployment, so its old execution evidence below is historical and must not
be presented as a record currently retrievable from this endpoint.

Compatibility verified on 2026-09-30 (KST):

- Health, quote, batch creation, batch detail, payments, progress and reconciliation respond.
- The remote quote omits fee-cap fields. The client derives the agreed 2× GasFree
  estimate cap and principal-plus-cap maximum debit, checking any supplied fields.
- The remote progress endpoint supplies a percentage and counts without stages.
  The adapter preserves that percentage and uses recorded batch/payment evidence
  for stage labels. READY does not become a submitted or paid batch.
- The remote engine does not provide `/signing-context`. Only on a 404, the local
  bridge reads the remote batch and fresh official GasFree account/provider data
  to construct unsigned TIP-712 data. Signing remains in the connected wallet.
- The remote engine does not provide `/fees`. Reconciliation remains available;
  no substitute fee-evidence report is fabricated.
- TronLink rejects third-party PermitTransfer prompts. The fallback prepares the
  remote batch first, then asks the user to send the quoted USDT principal from
  GasFree inside TronLink to the Executor address. A loopback bridge endpoint
  reads the Executor's Nile USDT `balanceOf` directly; it does not infer funding
  from a UI action or a provider status. Payout submission is a separate,
  explicit user action after the full principal is confirmed on-chain. The UI
  now calls `/resume`, which rechecks the actual Executor balance and enters the
  normal recovery worker. A deposit alone does not start payouts.
- The first manual test called `/execute-direct` and received `Direct execution
  is disabled`. That endpoint is intentionally gated by
  `ENABLE_DIRECT_EXECUTION=1`, and the remote engine had it disabled. The batch
  remained `READY` with its entire 0.06 USDT principal in the Executor. Its
  0%/waiting UI state had also relied on engine status without reading funding.
  The UI now reads Nile balance for a `READY` batch and labels funded-but-not-paid
  accurately. `/resume` was verified on that same funded batch without changing
  the server's direct-execution flag.
- The status poll previously cleared action errors every three seconds after a
  successful read. This hid the `Direct execution is disabled` failure and made
  the page appear to revert to a waiting state. Polling now maintains its own
  refresh error; payout-action failures remain visible until dismissed or a new
  action begins. A funded `READY` batch displays a resume action after reload.
- The remote factory/implementation pair is explicitly allowlisted in the client;
  recipient commitment, CREATE2 address, domain, wallet and fee-cap checks remain.

Verification batch: `b_1790703129797_ee596bf1`, one 0.01 USDT payment. It is READY:
created for integration checks, **not signed or executed**. Live quote: 0.3 USDT
estimated GasFree fee; client authorization ceiling: 0.6 USDT; maximum debit:
0.61 USDT. Fresh signing data was successfully retrieved, including current nonce.

Live manual-route verification on 2026-09-30 (KST): batch
`b_1790707208455_db092e92` had three 0.01/0.02/0.03 USDT rows. Nile USDT
`balanceOf(TAntJFoYwmomMcnfV7w97ymTxco72h1KD8)` returned 60,000 atomic units
before recovery. `/resume` returned 202 and the batch advanced through
`PAYOUT_PENDING` to `SUCCESS`. All three payouts were `CONFIRMED` with hashes
`80365d5884ea564c4a51217797ecc6c621a65ac980eb2b0e56366836e71a559d`,
`d04c24939e73bdc1c5ac8fd978044f6569f23ea087996966b5b1c1e84f1f860f`,
and `e1adee21dfb75053f9ac578053a7a41ba51cffdb003a88507f035c7f78ab8abe`.
The engine's three-way reconciliation returned `FINAL` with all checks matched.
Because this was a manual transfer, the engine has no provider trace or stored
deposit transaction hash; those evidence fields must remain unavailable.
