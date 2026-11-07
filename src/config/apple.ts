import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import fs from "fs";

const bundleId = process.env.APPLE_BUNDLE_ID!;

/**
 * Apple's guidance: validate against Production first, then fall back to
 * Sandbox. App Review and TestFlight purchase in the Sandbox, live customers
 * in Production, and both reach this same server. APPLE_ENVIRONMENT only
 * decides which environment is tried first.
 */
const ENVIRONMENTS: Environment[] =
  process.env.APPLE_ENVIRONMENT?.trim().toLowerCase() === "sandbox"
    ? [Environment.SANDBOX, Environment.PRODUCTION]
    : [Environment.PRODUCTION, Environment.SANDBOX];

/** The environment tried first. */
const environment = ENVIRONMENTS[0];

// App Apple ID, required by the Production verifier.
const appAppleId = Number(process.env.APPLE_ID || 6776775876);

/** Runs `fn` for each environment in order; returns the first success. */
async function tryEnvironments<T>(
  label: string,
  fn: (env: Environment) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const env of ENVIRONMENTS) {
    try {
      return await fn(env);
    } catch (error) {
      lastError = error;
      console.log(`↪️ ${label} failed in ${env}, trying the next environment`);
    }
  }
  throw lastError;
}

let verifiers: Map<Environment, SignedDataVerifier> | null = null;

try {
  // Try multiple certificate paths for different environments
  const certPaths = [
    "./certs/AppleRootCA-G3.cer", // Local development
    "/var/task/certs/AppleRootCA-G3.cer", // Vercel serverless
    "/tmp/certs/AppleRootCA-G3.cer", // Alternative Vercel path
  ];
  const certPath = certPaths.find((path) => fs.existsSync(path)) ?? null;

  if (certPath) {
    const appleRootCAs = [fs.readFileSync(certPath)];
    const enableOnlineChecks = true;
    verifiers = new Map(
      ENVIRONMENTS.map((env) => [
        env,
        new SignedDataVerifier(
          appleRootCAs,
          enableOnlineChecks,
          env,
          bundleId,
          appAppleId,
        ),
      ]),
    );
    console.log(
      `✅ Apple verification enabled for ${ENVIRONMENTS.join(" → ")} (${certPath})`,
    );
  } else {
    console.log(
      "⚠️ Apple certificates not found - running in development mode",
    );
  }
} catch (error: any) {
  console.log(
    "⚠️ Certificate loading failed - running in development mode:",
    error.message,
  );
}

/**
 * Same methods as SignedDataVerifier, but accepts data signed in either
 * Production or Sandbox.
 */
const verifier = verifiers
  ? {
      verifyAndDecodeTransaction: (signed: string) =>
        tryEnvironments("verifyAndDecodeTransaction", (env) =>
          verifiers!.get(env)!.verifyAndDecodeTransaction(signed),
        ),
      verifyAndDecodeRenewalInfo: (signed: string) =>
        tryEnvironments("verifyAndDecodeRenewalInfo", (env) =>
          verifiers!.get(env)!.verifyAndDecodeRenewalInfo(signed),
        ),
      verifyAndDecodeNotification: (signed: string) =>
        tryEnvironments("verifyAndDecodeNotification", (env) =>
          verifiers!.get(env)!.verifyAndDecodeNotification(signed),
        ),
    }
  : null;

export { verifier, bundleId, environment, ENVIRONMENTS, tryEnvironments };
