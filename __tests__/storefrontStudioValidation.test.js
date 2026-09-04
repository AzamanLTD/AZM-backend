const { validateStudioDocument } = require('../services/storefrontStudioValidation');

describe('storefrontStudioValidation', () => {
    const base = () => ({
        schemaVersion: 2,
        pages: [{ id: 'home', name: 'Home', slug: '/', root: ['button'] }],
        nodes: {
            button: {
                id: 'button',
                type: 'button',
                props: { label: 'Buy now' },
                style: { variant: 'filled' },
                layout: { mode: 'flow' },
                responsive: {},
                actions: { tap: { type: 'openCart' } },
                children: [],
            },
        },
        theme: { tokens: {} },
        navigation: {},
        assets: [],
    });

    test('accepts a bounded valid semantic document', () => {
        expect(validateStudioDocument(base())).toMatchObject({ valid: true, nodeCount: 1, pageCount: 1 });
    });

    test('rejects unsupported node types and dangling children', () => {
        const invalidType = base();
        invalidType.nodes.button.type = 'script';
        expect(() => validateStudioDocument(invalidType)).toThrow(/Unsupported node type/);

        const dangling = base();
        dangling.pages[0].root = ['missing'];
        expect(() => validateStudioDocument(dangling)).toThrow(/Unknown child\/root node reference/);
    });

    test('rejects cycles and excessive depth', () => {
        const cycle = base();
        cycle.nodes.button.children = ['button'];
        expect(() => validateStudioDocument(cycle)).toThrow(/cycle/);

        const deep = base();
        let parent = 'button';
        for (let i = 0; i < 13; i += 1) {
            const id = `node-${i}`;
            deep.nodes[id] = { id, type: 'section', children: [], props: {}, style: {}, layout: {}, responsive: {}, actions: {} };
            deep.nodes[parent].children = [id];
            parent = id;
        }
        expect(() => validateStudioDocument(deep)).toThrow(/maximum depth/);
    });

    test('rejects unsafe actions and executable-looking fields', () => {
        const unsafeAction = base();
        unsafeAction.nodes.button.actions.tap = { type: 'openExternalUrl', url: 'javascript:alert(1)' };
        expect(() => validateStudioDocument(unsafeAction)).toThrow(/external URL must use http or https/);

        const unsafeField = base();
        unsafeField.nodes.button.props.innerHTML = '<script>alert(1)</script>';
        expect(() => validateStudioDocument(unsafeField)).toThrow(/not allowed/);
    });

    test('rejects oversized document structure', () => {
        const doc = base();
        for (let i = 0; i < 251; i += 1) {
            doc.nodes[`n-${i}`] = { id: `n-${i}`, type: 'spacer', children: [], props: {}, style: {}, layout: {}, responsive: {}, actions: {} };
        }
        expect(() => validateStudioDocument(doc)).toThrow(/at most 250 nodes/);
    });
});
