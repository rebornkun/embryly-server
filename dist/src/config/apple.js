import { Environment, SignedDataVerifier, } from "@apple/app-store-server-library";
import fs from "fs";
const bundleId = process.env.APPLE_BUNDLE_ID;
console.log("🔍 APPLE_ENVIRONMENT raw value:", JSON.stringify(process.env.APPLE_ENVIRONMENT));
const environment = process.env.APPLE_ENVIRONMENT?.trim().toLowerCase() === "production"
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
console.log("🔍 Resolved environment:", environment);
let verifier = null;
try {
    // Try multiple certificate paths for different environments
    const certPaths = [
        "./certs/AppleRootCA-G3.cer", // Local development
        "/var/task/certs/AppleRootCA-G3.cer", // Vercel serverless
        "/tmp/certs/AppleRootCA-G3.cer", // Alternative Vercel path
    ];
    console.log("🔍 Checking certificate paths:", certPaths);
    let certPath = null;
    for (const path of certPaths) {
        console.log(`🔍 Checking path: ${path} - exists: ${fs.existsSync(path)}`);
        if (fs.existsSync(path)) {
            certPath = path;
            break;
        }
    }
    if (certPath) {
        const appleRootCAs = [fs.readFileSync(certPath)];
        const enableOnlineChecks = true;
        // App Apple ID is required for Production, optional for Sandbox
        const appAppleId = process.env.APPLE_ID
            ? Number(process.env.APPLE_ID)
            : undefined;
        verifier = new SignedDataVerifier(appleRootCAs, enableOnlineChecks, environment, bundleId, appAppleId);
        console.log(`✅ Apple certificate verification enabled (${certPath})`);
    }
    else {
        console.log("⚠️ Apple certificates not found - running in development mode");
    }
}
catch (error) {
    console.log("⚠️ Certificate loading failed - running in development mode:", error.message);
}
export { verifier, bundleId, environment };
