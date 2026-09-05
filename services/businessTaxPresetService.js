'use strict';

const TAX_TYPES = new Set(['PERCENTAGE', 'FLAT']);

const fail = (message, code) => {
    const error = new Error(message);
    if (code) error.code = code;
    return error;
};

const normalizeInput = ({ name, type, value, isDefault }) => {
    const normalizedName = String(name ?? '').trim();
    if (!normalizedName) throw fail('name is required.', 'INVALID_TAX_PRESET');
    if (normalizedName.length > 100) throw fail('name must be 100 characters or fewer.', 'INVALID_TAX_PRESET');

    if (!TAX_TYPES.has(type)) throw fail('type must be PERCENTAGE or FLAT.', 'INVALID_TAX_PRESET');

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        throw fail('value must be a finite non-negative number.', 'INVALID_TAX_PRESET');
    }

    return {
        name: normalizedName,
        type,
        value: numericValue,
        isDefault: Boolean(isDefault),
    };
};

const lockBusinessTaxPresets = async (tx, businessProfileId) => {
    // Every mutation that can change the set of defaults takes the same
    // transaction-scoped advisory lock. This makes create/update/delete
    // deterministic across concurrent requests before the database unique
    // index is even consulted.
    await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `business-tax-presets:${businessProfileId}`,
    );
};

const assertBusiness = async (tx, businessProfileId) => {
    if (!businessProfileId) throw fail('No business profile found.', 'BUSINESS_NOT_FOUND');
    const business = await tx.businessProfile.findUnique({
        where: { id: businessProfileId },
        select: { id: true },
    });
    if (!business) throw fail('Business profile not found.', 'BUSINESS_NOT_FOUND');
};

const listTaxPresets = async (prisma, businessProfileId) => {
    await assertBusiness(prisma, businessProfileId);
    return prisma.businessTaxPreset.findMany({
        where: { businessProfileId },
        orderBy: { createdAt: 'asc' },
    });
};

const createTaxPreset = async (prisma, businessProfileId, input) => {
    const normalized = normalizeInput(input);

    return prisma.$transaction(async (tx) => {
        await assertBusiness(tx, businessProfileId);
        await lockBusinessTaxPresets(tx, businessProfileId);

        if (normalized.isDefault) {
            await tx.businessTaxPreset.updateMany({
                where: { businessProfileId, isDefault: true },
                data: { isDefault: false },
            });
        }

        return tx.businessTaxPreset.create({
            data: {
                businessProfileId,
                name: normalized.name,
                type: normalized.type,
                value: normalized.value,
                isDefault: normalized.isDefault,
            },
        });
    });
};

const updateTaxPreset = async (prisma, businessProfileId, id, input) => {
    if (!id) throw fail('Tax preset id is required.', 'INVALID_TAX_PRESET');

    const patch = {};
    if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (!name || name.length > 100) throw fail('name must be 1–100 characters.', 'INVALID_TAX_PRESET');
        patch.name = name;
    }
    if (input.type !== undefined) {
        if (!TAX_TYPES.has(input.type)) throw fail('type must be PERCENTAGE or FLAT.', 'INVALID_TAX_PRESET');
        patch.type = input.type;
    }
    if (input.value !== undefined) {
        const numericValue = Number(input.value);
        if (!Number.isFinite(numericValue) || numericValue < 0) {
            throw fail('value must be a finite non-negative number.', 'INVALID_TAX_PRESET');
        }
        patch.value = numericValue;
    }
    if (input.isDefault !== undefined) patch.isDefault = Boolean(input.isDefault);

    if (Object.keys(patch).length === 0) throw fail('At least one field is required.', 'INVALID_TAX_PRESET');

    return prisma.$transaction(async (tx) => {
        await assertBusiness(tx, businessProfileId);
        await lockBusinessTaxPresets(tx, businessProfileId);

        const existing = await tx.businessTaxPreset.findFirst({
            where: { id, businessProfileId },
            select: { id: true },
        });
        if (!existing) throw fail('Tax preset not found.', 'TAX_PRESET_NOT_FOUND');

        if (patch.isDefault === true) {
            await tx.businessTaxPreset.updateMany({
                where: { businessProfileId, isDefault: true, id: { not: id } },
                data: { isDefault: false },
            });
        }

        return tx.businessTaxPreset.update({
            where: { id },
            data: patch,
        });
    });
};

const deleteTaxPreset = async (prisma, businessProfileId, id) => {
    if (!id) throw fail('Tax preset id is required.', 'INVALID_TAX_PRESET');

    return prisma.$transaction(async (tx) => {
        await assertBusiness(tx, businessProfileId);
        await lockBusinessTaxPresets(tx, businessProfileId);

        const deleted = await tx.businessTaxPreset.deleteMany({
            where: { id, businessProfileId },
        });
        if (deleted.count !== 1) throw fail('Tax preset not found.', 'TAX_PRESET_NOT_FOUND');
        return deleted;
    });
};

module.exports = {
    listTaxPresets,
    createTaxPreset,
    updateTaxPreset,
    deleteTaxPreset,
};
