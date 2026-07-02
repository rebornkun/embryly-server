import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import webhookRoutes from "./routes/webhook.js";
import healthRoutes from "./routes/health.js";
import validatePurchaseRoutes from "./routes/validate-purchase.js";
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
// Middleware
app.use(cors());
app.use(express.json({
    limit: "10mb",
    type: ["application/json", "application/jose"],
}));
// Routes
app.use(webhookRoutes);
app.use(healthRoutes);
app.use(validatePurchaseRoutes);
// Start server (only in development)
if (process.env.NODE_ENV !== "production") {
    app.listen(PORT, () => {
        console.log(`🚀 Apple webhook server running on port ${PORT}`);
        console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
    });
}
export default app;
