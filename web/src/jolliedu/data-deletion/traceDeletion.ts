import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma } from "@langfuse/shared/src/db";
import { traceDeletionProcessor, logger } from "@langfuse/shared/src/server";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

const DeleteTracesBody = z.object({
  traceIds: z.array(z.string().min(1)).min(1).max(1000),
});

/**
 * Self-built (non-EE) trace deletion endpoint. Delegates to the MIT shared
 * `traceDeletionProcessor`, which records `pendingDeletion` rows and enqueues
 * the `TraceDelete` job that purges the traces (and their observations/scores)
 * from ClickHouse/S3 in the worker.
 *
 *   POST /api/jolliedu/data-deletion/projects/{projectId}/traces
 *   body: { "traceIds": ["...", "..."] }
 *
 * Destructive and irreversible once the worker processes the job.
 */
export async function handleJolliEduTraceDeletion(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const projectId = z.string().safeParse(req.query.projectId);
  if (!projectId.success) {
    return res.status(400).json({ error: "Missing projectId in path" });
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId.data, deletedAt: null },
    });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const body = DeleteTracesBody.parse(req.body);
    await traceDeletionProcessor(projectId.data, body.traceIds);

    return res.status(202).json({
      projectId: projectId.data,
      traceIds: body.traceIds,
      status: "deletion_enqueued",
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid request body", details: e.issues });
    }
    logger.error("jolliedu trace-deletion endpoint failed", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
