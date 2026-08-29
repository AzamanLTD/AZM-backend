# Control Plane Financial Governance

The control plane exposes a read-only financial governance snapshot at `GET /api/admin/control-plane/financial-governance`.

## Scope

The endpoint reports:

- current `SystemProfitFees` treasury balance and update timestamp;
- pending, failed, and frozen-dispute `TransactionHistory` counts;
- platform profit totals and event counts over the last 24 hours and 7 days;
- cumulative profit grouped by the canonical `AdminProfitLog.source`.

## Safety contract

This surface is intentionally **read-only**. It does not create transactions, alter balances, resolve disputes, or write ledger records. Financial mutations remain inside the existing canonical services.

Access currently follows the established control-plane `staff.view` gate so the new read-only surface does not create an unseeded permission dependency. A narrower finance permission can be introduced later as part of a dedicated permission rollout.
