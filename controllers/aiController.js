const logger = require('../src/config/logger');

const getAiCapabilities = async (req, res) => {
    try {
        const capabilities = [
            {
                id: 'operational-cfo',
                name: 'Operational CFO',
                description: 'AI-powered financial analysis of operational expenses and MATIC balance health.',
                status: 'active',
                icon: 'chart-line',
                endpoint: '/api/admin/ai/cfo/analyze',
            },
            {
                id: 'dispute-assistant',
                name: 'Dispute Assistant',
                description: 'AI-assisted dispute resolution with evidence analysis and fairness scoring.',
                status: 'active',
                icon: 'scale-balanced',
                endpoint: '/api/admin/ai/dispute/analyze',
            },
            {
                id: 'smart-matchmaking',
                name: 'Smart Matchmaking',
                description: 'AI-sorted ad recommendations based on user preferences and payment methods.',
                status: 'active',
                icon: 'handshake',
                endpoint: '/api/ads/active?aiFilter=true',
            },
            {
                id: 'smart-queue',
                name: 'Smart Queue',
                description: 'Automated trade queue management when ads reach max concurrent capacity.',
                status: 'active',
                icon: 'list-ol',
                endpoint: '/api/ai/queue',
            },
        ];

        res.status(200).json({ success: true, capabilities });
    } catch (error) {
        logger.error('[AI Controller] getAiCapabilities error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const triggerCfoAnalysis = async (req, res) => {
    try {
        const CfoWorker = require('../workers/cfoWorker');
        const prisma = req.app.get('prisma');
        const worker = new CfoWorker(prisma);
        const result = await worker.analyzeExpenses();

        res.status(200).json({ success: true, analysis: result });
    } catch (error) {
        logger.error('[AI Controller] triggerCfoAnalysis error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getAiCapabilities,
    triggerCfoAnalysis,
};
