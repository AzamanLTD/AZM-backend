// workers/proofOfReservesWorker.js
// Operational snapshot worker. Snapshot creation is deliberately separate from
// the public GET endpoint so visitors cannot mutate financial history.
const logger = require('../src/config/logger');
const integrityService = require('../services/proofOfReservesIntegrityService');

async function run() {
  try {
    const { snapshot } = await integrityService.createSnapshot();
    logger.info({ snapshotId: snapshot.id, isFullyBacked: snapshot.isFullyBacked, totalLiabilities: snapshot.totalLiabilities.toString(), totalReserves: snapshot.totalReserves.toString() }, '[proofOfReserves] snapshot complete');
    return snapshot;
  } catch (err) {
    logger.error({ err: err.message }, '[proofOfReserves] scheduled snapshot failed');
    throw err;
  }
}

module.exports = { run };
