# Admin dispute force actions

The Admin dispute force-release and force-cancel endpoints both accept the same validated request shape: `tradeId` plus optional `adminNotes` (maximum 1000 characters).

Both commands require Admin authorization, and the settlement layer keeps the existing atomic state-claim behavior so concurrent finalization returns a conflict rather than duplicating a refund or release.
