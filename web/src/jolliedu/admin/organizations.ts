import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

const CreateOrgBody = z.object({
  name: z.string().min(1).max(60),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Optional: attach this existing user as OWNER in the same transaction, so
  // the org is visible in their UI. Omit for a headless org (machine
  // provisioning) that no user can see until a membership is added.
  ownerEmail: z.email().optional(),
});

/**
 * Self-built (non-EE) admin handler. Mirrors the MIT tRPC
 * `organizations.create` flow, authenticated by a static bearer token instead
 * of a user session. Does NOT depend on the EE `admin-api` entitlement.
 *
 *   POST /api/jolliedu/admin/organizations   -> create an organization
 *   GET  /api/jolliedu/admin/organizations   -> list organizations
 *
 * A static bearer token has no "creator" user, so orgs are headless by
 * default. Pass `ownerEmail` to attach an existing user as OWNER (the MIT
 * router does this implicitly for the session user) and make the org visible
 * in that user's UI.
 */
export async function handleJolliEduOrganizations(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  try {
    if (req.method === "POST") {
      const body = CreateOrgBody.parse(req.body);

      let ownerUserId: string | undefined;
      if (body.ownerEmail) {
        const user = await prisma.user.findUnique({
          where: { email: body.ownerEmail },
          select: { id: true },
        });
        if (!user) {
          return res
            .status(400)
            .json({ error: `No user found with email ${body.ownerEmail}` });
        }
        ownerUserId = user.id;
      }

      const organization = await prisma.organization.create({
        data: {
          name: body.name,
          ...(body.metadata
            ? { metadata: body.metadata as Prisma.InputJsonValue }
            : {}),
          ...(ownerUserId
            ? {
                organizationMemberships: {
                  create: { userId: ownerUserId, role: "OWNER" },
                },
              }
            : {}),
        },
      });
      return res.status(201).json({
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        metadata: organization.metadata,
        owner: body.ownerEmail ?? null,
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
