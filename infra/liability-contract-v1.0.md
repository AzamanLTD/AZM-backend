# Azaman Susu — Liability Contract v1.0

**Effective date:** 2026-05-31

This contract governs your participation in any Private Susu (Rotating
Savings and Credit Association) group hosted on the Azaman platform.

## 1. Acknowledgement

By accepting this contract you confirm:

- You are at least 18 years old and legally able to enter into financial
  obligations in your jurisdiction.
- You have completed Azaman Identity KYC and Proof of Residency
  verification before joining a Susu.
- You understand that a Susu is a fixed-schedule, fixed-amount commitment
  to contribute USDC to a shared pool on every cycle date for the full
  duration of the Susu.

## 2. Default and seizure

If your `availableBalance` is below the agreed contribution amount at the
moment a cycle's contribution is due, the platform will:

1. Seize whatever portion of your `availableBalance` exists, up to the
   contribution amount, and credit it to that cycle's payout recipient
   (or to the platform's dispute escrow if the recipient has themselves
   defaulted).
2. Mark you `DEFAULTED` for this Susu. This is a terminal status — you
   will not receive any further payouts in this Susu, including any
   future cycle for which you would have been the designated recipient.
3. Apply a Voucher Slash to the User who invited you: 25 percent of their
   AZM balance is deducted, and their global Trust Rating decreases by 1.

You acknowledge that defaulting on a Susu cycle is a breach of contract
and that the seizure, terminal status, and voucher penalty are automatic
and irreversible by you. The platform operator may, at its sole
discretion, reverse a seizure or restore an account through the Admin War
Room dispute process; that decision is not appealable.

## 3. Voucher liability

If you invite another User to a Susu, you become their Voucher for this
Susu. Their default in any cycle of this Susu triggers a Voucher Slash
against you (Section 2 paragraph 3) for every cycle in which they
default. You acknowledge that this liability is automatic and that you
are responsible for vetting the trustworthiness of every User you invite.

## 4. Cycle execution

Cycles run on the schedule pinned at activation. The platform's
`Cycle_Scheduler` automatically deducts contributions and pays out the
designated recipient at each cycle's scheduled run time. You consent to
the platform debiting your `availableBalance` without further prompt at
the cycle's scheduled time.

## 5. Privacy

Your participation in a Susu is private. The platform will not display
your Susu membership to any User who is not an `ACTIVE` member of the
same Susu, and will not include any Susu in public search results or
leaderboards.

## 6. Cancellation

The Susu Initiator may cancel the Susu before activation
(`SusuStatus.CONFIGURING`). After activation, no party may unilaterally
cancel — the Susu runs until every cycle is terminal. The platform
operator may freeze a Susu (`SusuStatus.FROZEN_DISPUTE`) when a Circuit
Breaker condition fires; resolution then follows the Admin War Room
process.

## 7. Disputes

You consent to the platform operator's resolution authority for any Susu
in `FROZEN_DISPUTE` status. The operator's decision in such cases is
final.

## 8. Amendments

The platform may publish a new version of this contract. Existing Susus
remain bound to the version pinned at their activation; new Susus created
after the publish timestamp use the new version.

## 9. Acceptance

By ticking the acceptance checkbox at Susu join time you record an
on-platform acceptance row tying your User id, the Susu id, this
contract version, the SHA-256 hash of this document body, the timestamp
of acceptance, your IP address, and your User-Agent. That row is the
binding artifact.

— Azaman Platform Operator
