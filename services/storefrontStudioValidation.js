'use strict';

// =============================================================================
// AZAMAN — STOREFRONT STUDIO V2 SERVER VALIDATOR
//
// The browser editor is not a trust boundary. This validator protects the
// publish/runtime boundary by constraining the semantic document to known
// nodes, bounded structure, safe actions and finite layout/style data.
// =============================================================================

const MAX_NODES = 250;
const MAX_DEPTH = 12;
const MAX_CHILDREN = 40;
const MAX_ACTIONS_PER_NODE = 8;
const MAX_STRING_LENGTH = 2000;

const NODE_TYPES = new Set([
    'page', 'section', 'stack', 'row', 'column', 'grid', 'overlay',
    'hero', 'product-grid', 'product-carousel', 'product-card', 'category-rail',
    'button', 'icon-button', 'text', 'image', 'video', 'rating', 'reviews',
    'contact', 'location', 'promo', 'social', 'spacer', 'divider'
]);

const ACTION_TYPES = new Set([
    'openProduct', 'openCategory', 'addToCart', 'openCart', 'checkout',
    'openStoreReviews', 'openStoreLocation', 'callBusiness', 'openExternalUrl',
    'navigatePage', 'scrollTo', 'followStore'
]);

const FORBIDDEN_KEYS = new Set([
    '__proto__', 'prototype', 'constructor', 'dangerouslySetInnerHTML',
    'innerHTML', 'outerHTML', 'script', 'javascript'
]);

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function walkSafeObject(value, path = '$') {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) walkSafeObject(value[i], `${path}[${i}]`);
        return;
    }
    if (!isPlainObject(value)) {
        if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
            throw validationError('STOREFRONT_STRING_TOO_LONG', `${path} exceeds the maximum allowed length.`);
        }
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
            throw validationError('STOREFRONT_UNSAFE_FIELD', `${path}.${key} is not allowed.`);
        }
        walkSafeObject(child, `${path}.${key}`);
    }
}

function validationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function validateAction(action, pageIds, nodeIds) {
    if (!isPlainObject(action)) return 'action must be an object.';
    if (!ACTION_TYPES.has(action.type)) return `unsupported action: ${action.type || '(missing)'}`;

    if (action.type === 'openProduct' || action.type === 'addToCart') {
        if (typeof action.productId !== 'string' || !action.productId.trim()) return 'productId is required.';
    }
    if (action.type === 'openCategory') {
        if (typeof action.categoryId !== 'string' || !action.categoryId.trim()) return 'categoryId is required.';
    }
    if (action.type === 'navigatePage') {
        if (typeof action.pageId !== 'string' || !pageIds.has(action.pageId)) return 'pageId must reference a published document page.';
    }
    if (action.type === 'scrollTo') {
        if (typeof action.nodeId !== 'string' || !nodeIds.has(action.nodeId)) return 'nodeId must reference a document node.';
    }
    if (action.type === 'openExternalUrl') {
        if (typeof action.url !== 'string' || action.url.length > MAX_STRING_LENGTH) return 'external URL is invalid.';
        let parsed;
        try { parsed = new URL(action.url); } catch { return 'external URL is invalid.'; }
        if (!['http:', 'https:'].includes(parsed.protocol)) return 'external URL must use http or https.';
        if (parsed.username || parsed.password) return 'external URL may not contain embedded credentials.';
    }
    if ('confirmation' in action && typeof action.confirmation !== 'boolean') return 'confirmation must be boolean.';
    return null;
}

function validateStudioDocument(document) {
    if (!isPlainObject(document)) throw validationError('STOREFRONT_DOCUMENT_REQUIRED', 'Studio document must be an object.');
    if (document.schemaVersion !== 2) throw validationError('STOREFRONT_SCHEMA_UNSUPPORTED', 'Studio document schemaVersion must be 2.');
    if (!Array.isArray(document.pages) || document.pages.length < 1 || document.pages.length > 20) {
        throw validationError('STOREFRONT_PAGE_COUNT_INVALID', 'Studio document must contain 1-20 pages.');
    }
    if (!isPlainObject(document.nodes)) throw validationError('STOREFRONT_NODES_REQUIRED', 'Studio document nodes must be an object.');

    const nodeEntries = Object.entries(document.nodes);
    if (nodeEntries.length > MAX_NODES) throw validationError('STOREFRONT_NODE_LIMIT', `Studio document may contain at most ${MAX_NODES} nodes.`);

    const nodeIds = new Set(nodeEntries.map(([id]) => id));
    const pageIds = new Set();
    const referenced = new Set();

    for (const page of document.pages) {
        if (!isPlainObject(page) || typeof page.id !== 'string' || !page.id.trim()) {
            throw validationError('STOREFRONT_PAGE_INVALID', 'Every Studio page needs a stable id.');
        }
        if (pageIds.has(page.id)) throw validationError('STOREFRONT_PAGE_DUPLICATE', `Duplicate page id: ${page.id}.`);
        pageIds.add(page.id);
        if (!Array.isArray(page.root) || page.root.length > MAX_CHILDREN) throw validationError('STOREFRONT_PAGE_ROOT_INVALID', `Invalid root for page ${page.id}.`);
        for (const childId of page.root) referenced.add(childId);
    }

    for (const [nodeId, node] of nodeEntries) {
        if (!isPlainObject(node) || node.id !== nodeId) throw validationError('STOREFRONT_NODE_INVALID', `Node ${nodeId} must have a matching id.`);
        if (!NODE_TYPES.has(node.type)) throw validationError('STOREFRONT_NODE_TYPE_INVALID', `Unsupported node type: ${node.type}.`);
        if (!Array.isArray(node.children) || node.children.length > MAX_CHILDREN) throw validationError('STOREFRONT_CHILDREN_INVALID', `Invalid children for node ${nodeId}.`);
        for (const childId of node.children) referenced.add(childId);
        if (node.actions != null) {
            const entries = Object.entries(node.actions);
            if (entries.length > MAX_ACTIONS_PER_NODE) throw validationError('STOREFRONT_ACTION_LIMIT', `Node ${nodeId} has too many actions.`);
            for (const [, action] of entries) {
                const problem = validateAction(action, pageIds, nodeIds);
                if (problem) throw validationError('STOREFRONT_ACTION_INVALID', `Node ${nodeId}: ${problem}`);
            }
        }
        walkSafeObject(node.props, `nodes.${nodeId}.props`);
        walkSafeObject(node.style, `nodes.${nodeId}.style`);
        walkSafeObject(node.layout, `nodes.${nodeId}.layout`);
        walkSafeObject(node.responsive, `nodes.${nodeId}.responsive`);
        if (node.children.includes(nodeId)) throw validationError('STOREFRONT_TREE_CYCLE', `Node ${nodeId} cannot contain itself.`);
    }

    for (const id of referenced) {
        if (!nodeIds.has(id)) throw validationError('STOREFRONT_DANGLING_REFERENCE', `Unknown child/root node reference: ${id}.`);
    }

    const visiting = new Set();
    const visited = new Set();
    const depthCheck = (id, depth) => {
        if (depth > MAX_DEPTH) throw validationError('STOREFRONT_DEPTH_LIMIT', `Studio tree exceeds maximum depth ${MAX_DEPTH}.`);
        if (visiting.has(id)) throw validationError('STOREFRONT_TREE_CYCLE', `Studio tree contains a cycle at ${id}.`);
        if (visited.has(id)) return;
        visiting.add(id);
        for (const childId of document.nodes[id].children) depthCheck(childId, depth + 1);
        visiting.delete(id);
        visited.add(id);
    };
    for (const page of document.pages) for (const rootId of page.root) depthCheck(rootId, 0);

    return {
        valid: true,
        nodeCount: nodeEntries.length,
        pageCount: document.pages.length,
    };
}

module.exports = {
    MAX_NODES,
    MAX_DEPTH,
    MAX_CHILDREN,
    NODE_TYPES,
    ACTION_TYPES,
    validateStudioDocument,
};
