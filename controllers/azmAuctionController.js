// controllers/azmAuctionController.js
// =============================================================================
// AZAMAN — AZM AUCTION CONTROLLER  (Master Sprint, 2026-05-27)
// =============================================================================

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        console.error(`[azmAuctionController] ${fn.name || 'h'}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

exports.current = wrap(async function current(req, res) {
    const svc = req.app.get('azmAuctionService');
    const result = await svc.getCurrent();
    res.json({ success: true, ...result });
});

exports.placeBid = wrap(async function placeBid(req, res) {
    const svc = req.app.get('azmAuctionService');
    const { adId, amountAzm } = req.body;
    const bid = await svc.placeBid({
        vendorId: req.user.id,
        adId,
        amountAzm,
    });
    res.status(201).json({ success: true, bid });
});

exports.withdrawBid = wrap(async function withdrawBid(req, res) {
    const svc = req.app.get('azmAuctionService');
    await svc.withdrawBid({ vendorId: req.user.id });
    res.json({ success: true });
});

exports.myBid = wrap(async function myBid(req, res) {
    const svc = req.app.get('azmAuctionService');
    const result = await svc.getMyBid(req.user.id);
    res.json({ success: true, ...result });
});

exports.history = wrap(async function history(req, res) {
    const svc = req.app.get('azmAuctionService');
    const bids = await svc.history(req.user.id, {
        limit: parseInt(req.query.limit, 10) || 20,
    });
    res.json({ success: true, bids });
});

exports.promoted = wrap(async function promoted(req, res) {
    const svc = req.app.get('azmAuctionService');
    const ads = await svc.getPromotedAds();
    res.json({ success: true, ads });
});
