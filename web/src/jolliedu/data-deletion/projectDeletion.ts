import { type NextApiRequest, type NextApiResponse } from "next";
import { randomUUID } from "crypto";
import * as z from "zod";
import { prisma } from "@langfuse/shared/src/db";
import {
  ProjectDeleteQueue,
  QueueJobs,
  redis,
  logger,
} from "@langfuse/shared/src/server";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

/**
 * Self-built (non-EE) project deletion endpoint. Mirrors the MIT tRPC
 * `projects.delete` flow: invalidate cached keys, hard-delete the project's
 * API keys, soft-delete the project row, then enqueue the async hard-delete
 * job (`ProjectDeleteQueue`) that purges ClickHouse/S3 data in the worker.
 *
 *   DELETE /api/jolliedu/data-deletion/projects/{projectId}?confirm=true
 *
 * Destructive and irreversible once the worker processes the job — the
 * `confirm=true` guard prevents accidental calls.
 */
export async function handleJolliEduProjectDeletion(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const projectId = z.string().safeParse(req.query.projectId);
  if (!projectId.success) {
    return res.status(400).json({ error: "Missing projectId in path" });
  }
  if (req.query.confirm !== "true") {
    return res.status(400).json({
      error: "Refusing to delete without confirm=true query parameter",
    });
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId.data, deletedAt: null },
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    // 1. Invalidate cached API keys so deleted keys stop authenticating.
    await new ApiAuthService(prisma, redis).invalidateCachedProjectApiKeys(
      projectId.data,
    );

    // 2. Hard-delete the project-scoped API keys.
    await prisma.apiKey.deleteMany({
      where: { projectId: projectId.data, scope: "PROJECT" },
    });

    // 3. Soft-delete the project row.
    await prisma.project.update({
      where: { id: projectId.data },
      data: { deletedAt: new Date() },
    });

    // 4. Enqueue the async hard-delete of ClickHouse/S3 data.
    const queue = ProjectDeleteQueue.getInstance();
    if (!queue) {
      return res.status(503).json({
        error: "ProjectDeleteQueue is not available. Please try again later.",
      });
    }
    await queue.add(QueueJobs.ProjectDelete, {
      timestamp: new Date(),
      id: randomUUID(),
      name: QueueJobs.ProjectDelete,
      payload: { projectId: projectId.data, orgId: project.orgId },
    });

    return res.status(202).json({
      projectId: projectId.data,
      status: "deletion_enqueued",
    });
  } catch (e) {
    logger.error("jolliedu project-deletion endpoint failed", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
