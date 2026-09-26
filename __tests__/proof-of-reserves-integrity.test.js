const {
  merkleRootFromHashes,
  merkleProofFromHashes,
  verifyMerkleProof,
  calculateReserveCoverage,
  sha256,
} = require('../services/proofOfReservesIntegrityService');

describe('Proof-of-reserves Merkle integrity', () => {
  test('root is deterministic and duplicates the odd leaf consistently', () => {
    const hashes = ['a', 'b', 'c'].map(sha256);
    expect(merkleRootFromHashes(hashes)).toBe(merkleRootFromHashes(hashes));
    expect(merkleRootFromHashes([])).toBe('0'.repeat(64));
  });

  test.each([0, 1, 2, 3, 4])('proof verifies for leaf index %i', index => {
    const hashes = ['u1', 'u2', 'u3', 'u4', 'u5'].map(sha256);
    const proof = merkleProofFromHashes(hashes, index);
    expect(verifyMerkleProof(hashes[index], proof, merkleRootFromHashes(hashes))).toBe(true);
  });

  test('tampering with a snapshot leaf fails verification', () => {
    const hashes = ['balance:10', 'balance:20', 'balance:30'].map(sha256);
    const proof = merkleProofFromHashes(hashes, 1);
    expect(verifyMerkleProof(sha256('balance:999'), proof, merkleRootFromHashes(hashes))).toBe(false);
  });

  test('proof ordering is bound to the user leaf index', () => {
    const hashes = ['user:1', 'user:2', 'user:3', 'user:4'].map(sha256);
    const root = merkleRootFromHashes(hashes);
    const proofForUser2 = merkleProofFromHashes(hashes, 1);
    const proofForUser3 = merkleProofFromHashes(hashes, 2);
    expect(verifyMerkleProof(hashes[1], proofForUser2, root)).toBe(true);
    expect(verifyMerkleProof(hashes[1], proofForUser3, root)).toBe(false);
  });

  test('fiat liquidity is never counted as USDT reserve backing', () => {
    const result = calculateReserveCoverage({
      systemCrypto: 60,
      hotWallet: 40,
      fiatPool: 1000,
      liabilities: 200,
    });
    expect(result.totalReserves).toBe(100);
    expect(result.reserveRatio).toBe(0.5);
    expect(result.fiatPool).toBe(1000);
  });
});
