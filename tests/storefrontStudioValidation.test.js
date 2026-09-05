const { validateStudioDocument } = require('../services/storefrontStudioValidation');

function node(id, grid, responsive = undefined) {
  return {
    id,
    type: 'section',
    children: [],
    props: {},
    style: {},
    layout: { grid },
    actions: {},
    ...(responsive ? { responsive } : {}),
  };
}

function documentWith(nodes, root = Object.keys(nodes)) {
  return {
    schemaVersion: 2,
    pages: [{ id: 'home', name: 'Home', slug: '/', root }],
    nodes,
  };
}

function expectValidationCode(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected validation error ${code}.`);
}

describe('storefront Studio geometry validation', () => {
  test('rejects an out-of-bounds responsive grid even when base geometry is valid', () => {
    const doc = documentWith({
      hero: node('hero', { row: 0, col: 0, rowSpan: 1, colSpan: 4 }, {
        phone: {
          layout: { grid: { row: 0, col: 3, rowSpan: 1, colSpan: 2 } },
        },
      }),
    });

    const error = expectValidationCode(
      () => validateStudioDocument(doc),
      'STOREFRONT_GRID_INVALID',
    );
    expect(error.message).toContain('phone viewport');
  });

  test('rejects sibling overlap introduced only at a responsive viewport', () => {
    const doc = documentWith({
      left: node('left', { row: 0, col: 0, rowSpan: 1, colSpan: 2 }),
      right: node('right', { row: 0, col: 2, rowSpan: 1, colSpan: 2 }, {
        phone: {
          layout: { grid: { row: 0, col: 1, rowSpan: 1, colSpan: 2 } },
        },
      }),
    });

    const error = expectValidationCode(
      () => validateStudioDocument(doc),
      'STOREFRONT_GRID_OVERLAP',
    );
    expect(error.message).toContain('phone viewport');
  });

  test('matches the browser tablet-to-desktop cascade when checking overlap', () => {
    const doc = documentWith({
      left: node('left', { row: 0, col: 0, rowSpan: 1, colSpan: 2 }, {
        phone: {
          layout: { grid: { row: 1, col: 0, rowSpan: 1, colSpan: 2 } },
        },
        tablet: { layout: {} },
      }),
      right: node('right', { row: 0, col: 2, rowSpan: 1, colSpan: 2 }, {
        tablet: {
          layout: { grid: { row: 1, col: 2, rowSpan: 1, colSpan: 2 } },
        },
        desktop: {
          layout: { grid: { row: 1, col: 0, rowSpan: 1, colSpan: 2 } },
        },
      }),
    });

    const error = expectValidationCode(
      () => validateStudioDocument(doc),
      'STOREFRONT_GRID_OVERLAP',
    );
    expect(error.message).toContain('desktop viewport');
  });

  test('validates orphan node geometry instead of only referenced siblings', () => {
    const doc = documentWith({
      visible: node('visible', { row: 0, col: 0, rowSpan: 1, colSpan: 4 }),
      orphan: node('orphan', { row: 0, col: 4, rowSpan: 1, colSpan: 1 }),
    }, ['visible']);

    expectValidationCode(
      () => validateStudioDocument(doc),
      'STOREFRONT_GRID_INVALID',
    );
  });

  test('accepts non-overlapping responsive geometry across all viewports', () => {
    const doc = documentWith({
      left: node('left', { row: 0, col: 0, rowSpan: 1, colSpan: 2 }, {
        phone: {
          layout: { grid: { row: 0, col: 0, rowSpan: 1, colSpan: 4 } },
        },
        tablet: {
          layout: { grid: { row: 0, col: 0, rowSpan: 1, colSpan: 2 } },
        },
      }),
      right: node('right', { row: 0, col: 2, rowSpan: 1, colSpan: 2 }, {
        phone: {
          layout: { grid: { row: 1, col: 0, rowSpan: 1, colSpan: 4 } },
        },
        tablet: {
          layout: { grid: { row: 0, col: 2, rowSpan: 1, colSpan: 2 } },
        },
      }),
    });

    expect(validateStudioDocument(doc)).toMatchObject({
      valid: true,
      nodeCount: 2,
      pageCount: 1,
    });
  });
});
