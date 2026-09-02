import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import {
  prisma,
  type AuditLog,
  AuditLogRecordType,
} from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

type UserActor = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

/**
 * Attach the acting user/API key to each audit log row. Mirrors the MIT
 * `mapAuditLogsWithActors` helper (web/src/server/api/routers/auditLogs.ts).
 */
function mapAuditLogsWithActors(
  auditLogs: AuditLog[],
  userMap: Map<string, UserActor>,
  apiKeyMap: Map<string, { id: string; publicKey: string }>,
) {
  return auditLogs.map((log) => {
    if (log.type === AuditLogRecordType.API_KEY) {
      return {
        ...log,
        actor: {
          type: log.type,
          body: apiKeyMap.get(log.apiKeyId ?? "") ?? {
            id: log.apiKeyId,
            publicKey: null,
          },
        },
      };
    }
    return {
      ...log,
      actor: {
        type: AuditLogRecordType.USER,
        body: userMap.get(log.userId ?? "") ?? {
          id: log.userId,
          name: null,
          email: null,
          image: null,
        },
      },
    };
  });
}

const ListQuery = z.object({
  // At least one scope is required; enforced below.
  orgId: z.string().optional(),
  projectId: z.string().optional(),
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Self-built (non-EE) audit-log read endpoint. Plain Prisma over the MIT
 * `audit_logs` table — the query shape mirrors the MIT
 * `auditLogsRouter` (web/src/server/api/routers/auditLogs.ts), NOT the EE
 * viewer (which is only a React table wrapper). Read-only.
 *
 *   GET /api/jolliedu/audit-log?orgId=&projectId=&page=&limit=
 *
 * Scope rules (match the MIT router):
 *   - projectId given            -> project-level events for that project
 *   - orgId given, no projectId  -> org-level events only (projectId IS NULL)
 */
export async function handleJolliEduAuditLogs(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const q = ListQuery.parse(req.query);
    if (!q.orgId && !q.projectId) {
      return res
        .status(400)
        .json({ error: "Provide at least one of orgId or projectId" });
    }

    const where = q.projectId
      ? { projectId: q.projectId }
      : { orgId: q.orgId!, projectId: null };

    const [auditLogs, totalCount] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: q.page * q.limit,
        take: q.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Resolve actors (user / API key) for display, scoped to the same
    // project or org as the query so we never leak identities across tenants.
    const userIds = [
      ...new Set(auditLogs.flatMap((log) => (log.userId ? [log.userId] : []))),
    ];
    const apiKeyIds = [
      ...new Set(
        auditLogs.flatMap((log) => (log.apiKeyId ? [log.apiKeyId] : [])),
      ),
    ];
    const apiKeyWhere = q.projectId
      ? { id: { in: apiKeyIds }, projectId: q.projectId }
      : {
          id: { in: apiKeyIds },
          orgId: q.orgId!,
          scope: "ORGANIZATION" as const,
        };

    const [users, apiKeys] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, image: true },
      }),
      prisma.apiKey.findMany({
        where: apiKeyWhere,
        select: { id: true, publicKey: true },
      }),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const apiKeyMap = new Map(apiKeys.map((k) => [k.id, k]));

    return res.status(200).json({
      auditLogs: mapAuditLogsWithActors(auditLogs, userMap, apiKeyMap),
      totalCount,
      page: q.page,
      limit: q.limit,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid query", details: e.issues });
    }
    logger.error("jolliedu audit-log endpoint failed", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
