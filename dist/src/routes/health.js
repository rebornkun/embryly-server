import { Router } from "express";
const router = Router();
router.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        webhook: "/webhook",
    });
});
router.get("/", (req, res) => {
    res.json({
        message: "Apple App Store Server Notifications Webhook",
        endpoints: {
            webhook: "/webhook",
            health: "/health",
        },
        note: "All purchases (subscriptions & consumables) are handled via Apple webhooks",
    });
});
export default router;
