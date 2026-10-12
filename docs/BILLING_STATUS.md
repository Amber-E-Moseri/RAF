# Billing Status

Status as of this branch (`fix/billing-entitlement-integrity`): **billing is not active.**

## Summary

- **No charges occur.** No code path creates a Stripe charge, invoice, or subscription.
- **The Stripe webhook processes nothing.** `POST /api/v1/billing/webhook` returns
  `501` for every request, with `processed: false`. It does not verify signatures, parse
  events, or change any state. Stripe is not integrated.
- **Paid Remi cannot be purchased.** Remi is paid only when `raf.workspaces.remi_tier = 'paid'`.
  No route, webhook, or application code writes that column. The database
  (migration `20261012020000_protect_workspace_remi_tier.sql`) rejects every write to it except
  from a privileged role.
- **Paid PDF import cannot be purchased.** `PATCH /api/v1/household/subscription` returns `501`
  (`code: BILLING_NOT_ACTIVE`). It no longer writes the PDF quota tier. `GET` still reports quota
  status. No route can set `pdf_import_quota_tier` to `paid`.
- **Paid Remi and paid PDF import are therefore unavailable to every user.** Every workspace is free.

## Endpoints

| Endpoint | Behaviour now |
| --- | --- |
| `POST /api/v1/billing/webhook` | `501`, nothing processed |
| `PATCH /api/v1/household/subscription` | `501`, nothing written |
| `GET /api/v1/household/subscription` | quota status (free) |
| `PATCH /api/v1/remi/upgrade` | `501` |
| `GET /api/v1/remi/upgrade` | Remi tier status (informational only) |

## How a workspace would become paid (not implemented)

Paid state must come only from a verified, privileged write path. That path does not exist yet.

1. A Stripe event is accepted only after its signature is verified against the raw body
   with the Stripe SDK and `STRIPE_WEBHOOK_SECRET`. This check must exist before any event is processed.
2. The verified event is applied by a dedicated billing service login role. That role must be
   granted membership of `raf_billing_service`. It must never be `raf_app`, and `raf_app`
   must never be a member of it. The migration refuses to run if it is.
3. The service sets `raf.workspaces.remi_tier` (and any PDF quota change) inside a DB transaction,
   after verification, and records an audit entry.

The table owner (migration/operations role) can also write `remi_tier` for backfills and repairs.
That is an operations action, not a product path.

## Database enforcement

- `raf.workspaces.remi_tier` is protected by the `trg_workspaces_protect_remi_tier` trigger
  (BEFORE INSERT OR UPDATE). Any change, or any non-`free` value on insert, requires
  membership of `raf_billing_service` or the table owner. Otherwise it raises SQLSTATE `42501`.
- Row-level security alone is not enough. The `workspaces_member_policy` lets any owner or admin
  update every column, and `workspaces_insert_policy` lets any user insert a workspace they own.
- Tests: `tests/billingEntitlementPostgres.test.js` (disposable Postgres) and
  `tests/billingEntitlementFailClosed.test.js` (in memory).

## Known gaps (must be resolved before billing goes live)

- `raf.households.pdf_import_quota_tier` and `raw_json.pdfImportQuotaTier` have no database-level
  protection. Only the absence of any route that writes them protects them. Add a trigger of the same
  kind before any privileged PDF-quota writer exists.
- Stripe signature verification and event idempotency are not implemented.
- The `raf_billing_service` login role, its grants, and its credentials are not provisioned.
- Downgrade and expiry handling for paid state is not designed.
