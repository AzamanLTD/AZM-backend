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

exports.getTab = async (prisma, { tabId }) => {
    const svc = new DineInService(prisma);
    return svc.getTabById(tabId);
};

exports.confirmAndPay = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.confirmAndPay(opts);
};

exports.reportDefault = async (prisma, opts) => {
    const svc = new DineInService(prisma);
    return svc.reportDefault(opts);
};
