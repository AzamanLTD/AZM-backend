// Adapter: bridges dineInController to DineInService class
const logger = require('../src/config/logger');
const { DineInService } = require('./marketplace/dineInService');

exports.openTab = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.openTab(opts);
};

exports.addItem = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.addItem(opts);
};

exports.finalizeTab = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.finalizeTab(opts);
};

exports.getTabs = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.getOpenTabs(opts);
};

exports.getTab = async (prisma, { tabId, customerId }) => {
    const svc = new DineInService(prisma);
    const tab = await svc.getTab(tabId);
    if (!tab) throw new Error('Tab not found.');
    if (customerId != null && tab.customerId !== customerId) {
        throw new Error('Not authorized to view this tab.');
    }
    return tab;
};

exports.confirmAndPay = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.confirmAndPay(opts);
};

exports.reportDefault = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.reportDefault(opts);
};
