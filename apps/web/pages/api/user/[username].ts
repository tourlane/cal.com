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
  const { username } = schema.parse(req.query);
  const deletedUser = await prisma.user.delete({
    where: {
      username,
    },
  });
  console.log(`User ${username} with email ${deletedUser.email} deleted successfully`);
  return res.status(200).json({ message: "Delete successful" });
}
