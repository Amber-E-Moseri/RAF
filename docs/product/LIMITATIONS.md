# Known Limitations

1. Debts are not period-aware in this release.
   Debt balances shown in the UI remain current cumulative balances rather than historical month-end balances.

2. Financial health remains current-month oriented in this release.
   `GET /reports/financial-health` still falls back to the household active month and has not been fully migrated to explicit period parameters yet.

3. Import transaction-date ownership is authoritative and immutable by design.
   Bank statement imports assign transactions to their actual statement dates. The period filter shows you the month a transaction belongs to; it does not re-attribute the transaction to a different period. This is an intentional invariant — imported dates reflect when the transaction occurred, not when you reviewed the import.

4. Allocation history is read-only.
   Users can inspect historical allocation snapshots, but they cannot restore an older snapshot as the current configuration in this release.
