const prisma = require('../../prisma/client');

/**
 * Service to handle dispatching notifications to external channels like SMS and WhatsApp
 * based on the business's NotificationPreferences.
 */
class MessagingChannelsService {
    /**
     * Checks if a specific channel is enabled for a given event in the business preferences.
     * @param {string} businessProfileId 
     * @param {string} eventType e.g., 'new_order', 'order_ready', 'booking_confirmed'
     * @param {string} channel e.g., 'sms', 'whatsapp'
     * @returns {Promise<boolean>}
     */
    async isChannelEnabled(businessProfileId, eventType, channel) {
        try {
            const prefs = await prisma.businessNotificationPreference.findUnique({
                where: { businessProfileId }
            });
            if (!prefs || !prefs.preferences) return false;
            
            const eventPrefs = prefs.preferences[eventType];
            if (!eventPrefs) return false;
            
            return !!eventPrefs[channel];
        } catch (error) {
            console.error('[MessagingChannels] Error checking preferences:', error);
            return false;
        }
    }

    /**
     * Simulates sending an SMS via an external provider (e.g., Twilio, Africa's Talking)
     */
    async sendSMS(phoneNumber, message) {
        console.log(`[MessagingChannels] 📲 Sending SMS to ${phoneNumber}: "${message}"`);
        // Mock external API call
        return Promise.resolve({ success: true, provider: 'mock_sms' });
    }

    /**
     * Simulates sending a WhatsApp message via an external provider (e.g., Twilio, Meta API)
     */
    async sendWhatsApp(phoneNumber, message) {
        console.log(`[MessagingChannels] 💬 Sending WhatsApp to ${phoneNumber}: "${message}"`);
        // Mock external API call
        return Promise.resolve({ success: true, provider: 'mock_whatsapp' });
    }

    /**
     * Dispatches a notification for an order being ready.
     * @param {string} businessProfileId
     * @param {string} customerPhone
     * @param {string} orderReference
     */
    async notifyOrderReady(businessProfileId, customerPhone, orderReference) {
        if (!customerPhone) return;

        const message = `Your order ${orderReference} is ready for pickup/delivery!`;
        const eventType = 'order_ready';

        if (await this.isChannelEnabled(businessProfileId, eventType, 'sms')) {
            await this.sendSMS(customerPhone, message);
        }

        if (await this.isChannelEnabled(businessProfileId, eventType, 'whatsapp')) {
            await this.sendWhatsApp(customerPhone, message);
        }
    }

    /**
     * Dispatches a notification for a booking confirmation.
     * @param {string} businessProfileId
     * @param {string} customerPhone
     * @param {string} bookingReference
     * @param {Date} bookingDate
     */
    async notifyBookingConfirmed(businessProfileId, customerPhone, bookingReference, bookingDate) {
        if (!customerPhone) return;

        const dateStr = new Date(bookingDate).toLocaleDateString();
        const message = `Your booking ${bookingReference} for ${dateStr} has been confirmed. See you soon!`;
        const eventType = 'booking_confirmed';

        if (await this.isChannelEnabled(businessProfileId, eventType, 'sms')) {
            await this.sendSMS(customerPhone, message);
        }

        if (await this.isChannelEnabled(businessProfileId, eventType, 'whatsapp')) {
            await this.sendWhatsApp(customerPhone, message);
        }
    }
}

module.exports = new MessagingChannelsService();
