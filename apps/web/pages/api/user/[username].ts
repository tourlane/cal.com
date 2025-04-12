import { Prisma } from "@prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import prisma from "@calcom/prisma";

const schema = z.object({
  username: z.string(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const secret = process.env.GLOBAL_WEBHOOK_SECRET;
  const providedSecret = req.headers.authorization?.replace("Bearer ", "");
  if (!providedSecret || providedSecret !== secret) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const { username } = schema.parse(req.query);
  try {
    const deletedUser = await prisma.user.delete({
      where: {
        username,
      },
    });

    console.log(`User "${username}" with email "${deletedUser.email}" deleted successfully`);
    return res.status(200).json({ message: `User "${username}" deleted successfully` });
  } catch (error) {
    // Check if this is a Prisma "Record not found" error
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return res.status(404).json({ message: `User "${username}" not found` });
    }

    console.error("Error deleting user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
