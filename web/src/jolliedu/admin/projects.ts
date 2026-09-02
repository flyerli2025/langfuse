import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

const CreateProjectBody = z.object({
  name: z.string().min(3).max(60),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Self-built (non-EE) admin handler. Mirrors the MIT tRPC `projects.create`
 * flow (duplicate-name guard + `prisma.project.create`), scoped to the org in
 * the path.
 *
 *   POST /api/jolliedu/admin/organizations/{orgId}/projects  -> create project
 *   GET  /api/jolliedu/admin/organizations/{orgId}/projects  -> list projects
 */
export async function handleJolliEduProjects(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  const orgId = z.string().safeParse(req.query.orgId);
  if (!orgId.success) {
    return res.status(400).json({ error: "Missing orgId in path" });
  }

  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId.data },
    });
    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    if (req.method === "POST") {
      const body = CreateProjectBody.parse(req.body);

      const existing = await prisma.project.findFirst({
        where: { name: body.name, orgId: orgId.data, deletedAt: null },
      });
      if (existing) {
        return res.status(409).json({
          error: "A project with this name already exists in this organization",
        });
      }

      const project = await prisma.project.create({
        data: {
          name: body.name,
          orgId: orgId.data,
          ...(body.metadata
            ? { metadata: body.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });
      return res.status(201).json({
        id: project.id,
        name: project.name,
        orgId: project.orgId,
        metadata: project.metadata,
      });
    }

    if (req.method === "GET") {
      const projects = await prisma.project.findMany({
        where: { orgId: orgId.data, deletedAt: null },
        select: { id: true, name: true, orgId: true, metadata: true },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json({ projects });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid request body", details: e.issues });
    }
    logger.error("jolliedu project endpoint failed", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
