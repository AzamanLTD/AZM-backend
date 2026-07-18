/**
 * Messaging Channels Service
 * 
 * Dispatches notifications to external channels (SMS, WhatsApp) based on
 * BusinessNotificationPreference + BusinessMessagingConfig.
 * 
 * Logs every send to BusinessMessageLog for cost tracking.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = global.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;

class MessagingChannelsService {
    async getConfig(businessProfileId) {
        return prisma.businessMessagingConfig.findUnique({
            where: { businessProfileId },
        });
    }

    async isChannelEnabled(businessProfileId, eventType, channel) {
        try {
            const prefs = await prisma.businessNotificationPreference.findUnique({
                where: { businessProfileId },
            });
            if (!prefs || !prefs.preferences) return false;

            const eventPrefs = prefs.preferences[eventType];
            if (!eventPrefs) return false;

            if (!eventPrefs[channel]) return false;

            const config = await this.getConfig(businessProfileId);
            if (channel === 'whatsapp') return !!config?.waConnected;
            if (channel === 'sms') return !!config?.smsConnected;

            return false;
        } catch (error) {
            console.error('[MessagingChannels] Error checking preferences:', error);
            return false;
        }
    }

    async sendSMS(businessProfileId, phoneNumber, message, eventType = null) {
        const config = await this.getConfig(businessProfileId);
        if (!config?.smsConnected) throw new Error('SMS channel not connected');

        // TODO: Replace with real Africa's Talking / Twilio API call
        console.log(`[MessagingChannels] SMS to ${phoneNumber}: "${message}"`);

        const result = { success: true, providerMessageId: `sms_${Date.now()}`, costGhs: 0.05 };

        await prisma.businessMessageLog.create({
            data: {
                businessProfileId,
                channel: 'sms',
                recipient: phoneNumber,
                message: message.substring(0, 500),
                status: 'SENT',
                providerMessageId: result.providerMessageId,
                costGhs: result.costGhs,
                eventType,
            },
        });

        return result;
    }

    async sendWhatsApp(businessProfileId, phoneNumber, message, eventType = null) {
        const config = await this.getConfig(businessProfileId);
        if (!config?.waConnected) throw new Error('WhatsApp channel not connected');

        // TODO: Replace with real Meta WhatsApp Cloud API call
        console.log(`[MessagingChannels] WhatsApp to ${phoneNumber}: "${message}"`);

        const result = { success: true, providerMessageId: `wa_${Date.now()}`, costGhs: 0.035 };

        await prisma.businessMessageLog.create({
            data: {
                businessProfileId,
                channel: 'whatsapp',
                recipient: phoneNumber,
                message: message.substring(0, 500),
                status: 'SENT',
                providerMessageId: result.providerMessageId,
                costGhs: result.costGhs,
                eventType,
            },
        });

        return result;
    }

    async dispatchNotification(businessProfileId, customerPhone, eventType, message) {
        if (!customerPhone) return { sent: 0, channels: [] };

        const channels = [];
        let sent = 0;

        if (await this.isChannelEnabled(businessProfileId, eventType, 'sms')) {
            try {
                await this.sendSMS(businessProfileId, customerPhone, message, eventType);
                channels.push({ channel: 'sms', status: 'SENT' });
                sent++;
            } catch (err) {
                channels.push({ channel: 'sms', status: 'FAILED', error: err.message });
            }
        }

        if (await this.isChannelEnabled(businessProfileId, eventType, 'whatsapp')) {
            try {
                await this.sendWhatsApp(businessProfileId, customerPhone, message, eventType);
                channels.push({ channel: 'whatsapp', status: 'SENT' });
                sent++;
            } catch (err) {
                channels.push({ channel: 'whatsapp', status: 'FAILED', error: err.message });
            }
        }

        return { sent, channels };
    }

    async notifyOrderReady(businessProfileId, customerPhone, orderReference) {
        const message = `Your order ${orderReference} is ready for pickup/delivery!`;
        return this.dispatchNotification(businessProfileId, customerPhone, 'order_ready', message);
    }

    async notifyBookingConfirmed(businessProfileId, customerPhone, bookingReference, bookingDate) {
        const dateStr = new Date(bookingDate).toLocaleDateString();
        const message = `Your booking ${bookingReference} for ${dateStr} has been confirmed. See you soon!`;
        return this.dispatchNotification(businessProfileId, customerPhone, 'booking_confirmed', message);
    }
}

module.exports = new MessagingChannelsService();
