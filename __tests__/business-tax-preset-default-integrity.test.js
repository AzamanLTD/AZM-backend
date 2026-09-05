'use strict';

const assert = require('node:assert/strict');
const {
    createTaxPreset,
    updateTaxPreset,
    deleteTaxPreset,
} = require('../services/businessTaxPresetService');

function transactionalPrisma({ presets = [] } = {}) {
    const state = { presets: presets.map((p) => ({ ...p })) };
    const calls = [];

    const tx = {
        $queryRawUnsafe: async (...args) => {
            calls.push(['lock', ...args]);
            return [];
        },
        businessProfile: {
            findUnique: async () => ({ id: 'biz-1' }),
        },
        businessTaxPreset: {
            findMany: async ({ where }) => state.presets.filter((p) => p.businessProfileId === where.businessProfileId),
            findFirst: async ({ where }) => state.presets.find((p) => p.id === where.id && p.businessProfileId === where.businessProfileId) || null,
            updateMany: async ({ where, data }) => {
                let count = 0;
                for (const p of state.presets) {
                    const matchesBusiness = p.businessProfileId === where.businessProfileId;
                    const matchesDefault = where.isDefault === undefined || p.isDefault === where.isDefault;
                    const matchesId = !where.id?.not || p.id !== where.id.not;
                    if (matchesBusiness && matchesDefault && matchesId) {
                        Object.assign(p, data);
                        count += 1;
                    }
                }
                return { count };
            },
            create: async ({ data }) => {
                const preset = { id: `new-${state.presets.length + 1}`, createdAt: new Date(), ...data };
                state.presets.push(preset);
                return preset;
            },
            update: async ({ where, data }) => {
                const preset = state.presets.find((p) => p.id === where.id);
                Object.assign(preset, data);
                return preset;
            },
            deleteMany: async ({ where }) => {
                const before = state.presets.length;
                state.presets = state.presets.filter((p) => !(p.id === where.id && p.businessProfileId === where.businessProfileId));
                return { count: before - state.presets.length };
            },
        },
    };

    return {
        state,
        calls,
        $transaction: async (callback) => callback(tx),
        businessTaxPreset: tx.businessTaxPreset,
    };
}

describe('BusinessTaxPreset default integrity', () => {
    test('promoting a preset clears all other defaults inside one transaction', async () => {
        const prisma = transactionalPrisma({ presets: [
            { id: 'old-1', businessProfileId: 'biz-1', name: 'VAT', type: 'PERCENTAGE', value: 15, isDefault: true },
            { id: 'old-2', businessProfileId: 'biz-1', name: 'NHIL', type: 'PERCENTAGE', value: 2.5, isDefault: true },
            { id: 'target', businessProfileId: 'biz-1', name: 'Service', type: 'FLAT', value: 2, isDefault: false },
        ] });

        const updated = await updateTaxPreset(prisma, 'biz-1', 'target', { isDefault: true });

        assert.equal(updated.isDefault, true);
        assert.deepEqual(prisma.state.presets.filter((p) => p.isDefault).map((p) => p.id), ['target']);
        assert.equal(prisma.calls.filter(([kind]) => kind === 'lock').length, 1);
    });

    test('create-default takes the same business lock before clearing defaults', async () => {
        const prisma = transactionalPrisma({ presets: [
            { id: 'old', businessProfileId: 'biz-1', name: 'VAT', type: 'PERCENTAGE', value: 15, isDefault: true },
        ] });

        const created = await createTaxPreset(prisma, 'biz-1', {
            name: 'NHIL', type: 'PERCENTAGE', value: 2.5, isDefault: true,
        });

        assert.equal(created.isDefault, true);
        assert.deepEqual(prisma.state.presets.filter((p) => p.isDefault).map((p) => p.name), ['NHIL']);
        assert.equal(prisma.calls[0][0], 'lock');
    });

    test('cross-business updates cannot mutate another business preset', async () => {
        const prisma = transactionalPrisma({ presets: [
            { id: 'foreign', businessProfileId: 'biz-2', name: 'VAT', type: 'PERCENTAGE', value: 15, isDefault: true },
        ] });

        await assert.rejects(
            updateTaxPreset(prisma, 'biz-1', 'foreign', { name: 'tampered' }),
            (error) => error.code === 'TAX_PRESET_NOT_FOUND',
        );
        assert.equal(prisma.state.presets[0].name, 'VAT');
    });

    test('delete is serialized and tenant-scoped', async () => {
        const prisma = transactionalPrisma({ presets: [
            { id: 'owned', businessProfileId: 'biz-1', name: 'VAT', type: 'PERCENTAGE', value: 15, isDefault: true },
            { id: 'foreign', businessProfileId: 'biz-2', name: 'VAT', type: 'PERCENTAGE', value: 15, isDefault: true },
        ] });

        await deleteTaxPreset(prisma, 'biz-1', 'owned');
        assert.deepEqual(prisma.state.presets.map((p) => p.id), ['foreign']);
        assert.equal(prisma.calls.filter(([kind]) => kind === 'lock').length, 1);
    });

    test('invalid non-finite tax values are rejected before persistence', async () => {
        const prisma = transactionalPrisma();
        await assert.rejects(
            createTaxPreset(prisma, 'biz-1', {
                name: 'Broken', type: 'PERCENTAGE', value: Infinity, isDefault: false,
            }),
            (error) => error.code === 'INVALID_TAX_PRESET',
        );
        assert.equal(prisma.state.presets.length, 0);
    });
});
