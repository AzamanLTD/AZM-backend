// __tests__/webhook-emitter.test.js
// =============================================================================
// Webhook emitter tests — verifies fire-and-forget behavior, error suppression,
// and lazy loading of the dispatcher.
// =============================================================================

// Mock the dispatcher module before requiring the emitter
jest.mock('../services/webhookDispatcher', () => ({
    dispatch: jest.fn(),
}));

const { emitWebhookEvent } = require('../services/webhookEmitter');
const dispatcher = require('../services/webhookDispatcher');

describe('Webhook Emitter', () => {
  beforeEach(() => jest.clearAllMocks());

  test('calls dispatcher.dispatch with correct args', async () => {
    dispatcher.dispatch.mockResolvedValue(undefined);
    await emitWebhookEvent('biz-1', 'order.created', { orderId: 1 });
    expect(dispatcher.dispatch).toHaveBeenCalledWith('biz-1', 'order.created', { orderId: 1 });
  });

  test('does nothing when businessProfileId is missing', async () => {
    await emitWebhookEvent(null, 'order.created', {});
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  test('does nothing when eventType is missing', async () => {
    await emitWebhookEvent('biz-1', null, {});
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  test('suppresses dispatcher errors (never throws)', async () => {
    dispatcher.dispatch.mockRejectedValue(new Error('DB connection lost'));
    // Should NOT throw
    await expect(emitWebhookEvent('biz-1', 'order.created', {})).resolves.toBeUndefined();
  });

  test('suppressed error does not break the flow', async () => {
    dispatcher.dispatch.mockRejectedValue(new Error('Network error'));
    const result = await emitWebhookEvent('biz-1', 'invoice.created', { invoiceId: 5 });
    expect(result).toBeUndefined();
  });
});
