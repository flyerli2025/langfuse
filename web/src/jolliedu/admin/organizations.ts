import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

const CreateOrgBody = z.object({
  name: z.string().min(1).max(60),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Self-built (non-EE) admin handler. Mirrors the MIT tRPC
 * `organizations.create` flow, authenticated by a static bearer token instead
 * of a user session. Does NOT depend on the EE `admin-api` entitlement.
 *
 *   POST /api/jolliedu/admin/organizations   -> create an organization
 *   GET  /api/jolliedu/admin/organizations   -> list organizations
 */
export async function handleJolliEduOrganizations(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  try {
    if (req.method === "POST") {
      const body = CreateOrgBody.parse(req.body);
      const organization = await prisma.organization.create({
        data: {
          name: body.name,
          ...(body.metadata
            ? { metadata: body.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });
      return res.status(201).json({
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        metadata: organization.metadata,
      });
    }

    if (req.method === "GET") {
      const organizations = await prisma.organization.findMany({
        select: { id: true, name: true, createdAt: true, metadata: true },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json({ organizations });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid request body", details: e.issues });
    }
    logger.error("jolliedu org endpoint failed", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
