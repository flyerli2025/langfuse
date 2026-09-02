import { type NextApiRequest, type NextApiResponse } from "next";
import * as crypto from "crypto";
import { env } from "@/src/env.mjs";
import { logger } from "@langfuse/shared/src/server";

/**
 * Authentication for the self-built (non-EE) jolliedu admin REST API.
 *
 * This intentionally does NOT reuse the EE `AdminApiAuthService`
 * (web/src/ee/features/admin-api/*), which is under the Enterprise License.
 * It is an independent implementation over the MIT core: a single static
 * bearer token supplied via the `SELF_ADMIN_API_KEY` env var, sent as
 * `Authorization: Bearer <token>`.
 *
 * Returns true when the caller is authorized. On failure it writes the
 * response (401/403/503) and returns false, so callers can `if (!ok) return;`.
 */
export function verifyJolliEduAdminAuth(
  req: NextApiRequest,
  res: NextApiResponse,
): boolean {
  const configuredToken = env.SELF_ADMIN_API_KEY;

  // Fail closed: if no token is configured, the endpoint is disabled entirely.
  if (!configuredToken) {
    res.status(503).json({
      error:
        "jolliedu admin API is disabled. Set SELF_ADMIN_API_KEY to enable.",
    });
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ error: "Missing or malformed Authorization header" });
    return false;
  }
  const providedToken = authHeader.slice("Bearer ".length);

  // Constant-time comparison via timingSafeEqual, which requires equal-length
  // buffers. The token is a high-entropy, fixed-length random value, so its
  // length is not sensitive: guard the length first (short-circuiting a
  // mismatch), then compare the bytes in constant time. The secret is not
  // hashed — it is not a low-entropy password, so no hash/KDF is warranted,
  // and comparing the raw bytes avoids a needless hashing step.
  const providedBuf = Buffer.from(providedToken, "utf8");
  const configuredBuf = Buffer.from(configuredToken, "utf8");
  const isValid =
    providedBuf.length === configuredBuf.length &&
    crypto.timingSafeEqual(providedBuf, configuredBuf);

  if (!isValid) {
    logger.warn("jolliedu admin API: invalid bearer token");
    res.status(403).json({ error: "Invalid admin token" });
    return false;
  }

  return true;
}
