import { type NextApiRequest, type NextApiResponse } from "next";
import * as z from "zod";
import { prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { createAndAddApiKeysToDb } from "@langfuse/shared/src/server/auth/apiKeys";
import { verifyJolliEduAdminAuth } from "@/src/jolliedu/auth";

const CreateApiKeyBody = z.object({
  note: z.string().max(200).optional(),
});

/**
 * Self-built (non-EE) admin handler. Mints a PROJECT-scoped ingestion key
 * pair (pk-lf-… / sk-lf-…) via the MIT shared primitive
 * `createAndAddApiKeysToDb`. The plaintext secret is returned exactly once.
 *
 *   POST /api/jolliedu/admin/projects/{projectId}/apiKeys  -> create key
 *   GET  /api/jolliedu/admin/projects/{projectId}/apiKeys  -> list (masked)
 */
export async function handleJolliEduApiKeys(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!verifyJolliEduAdminAuth(req, res)) return;

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

    if (req.method === "POST") {
      const body = CreateApiKeyBody.parse(req.body ?? {});
      const key = await createAndAddApiKeysToDb({
        prisma,
        entityId: projectId.data,
        scope: "PROJECT",
        note: body.note,
      });
      // secretKey is returned ONLY here and never retrievable again.
      return res.status(201).json({
        id: key.id,
        publicKey: key.publicKey,
        secretKey: key.secretKey,
        displaySecretKey: key.displaySecretKey,
        note: key.note,
        createdAt: key.createdAt,
      });
    }

    if (req.method === "GET") {
      const keys = await prisma.apiKey.findMany({
        where: { projectId: projectId.data, scope: "PROJECT" },
        select: {
          id: true,
          publicKey: true,
          displaySecretKey: true,
          note: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json({ apiKeys: keys });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid request body", details: e.issues });
    }
    logger.error("jolliedu apiKey endpoint failed", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}
