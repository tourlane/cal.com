import type { NextApiRequest } from "next";

import handleNewBooking from "@calcom/features/bookings/lib/handleNewBooking";
import { getSession } from "@calcom/lib/auth";
import { defaultResponder } from "@calcom/lib/server";

import { tracerProvider } from "@lib/open-telemetry-provider";

async function handler(req: NextApiRequest & { userId?: number }) {
  const session = await getSession({ req });
  /* To mimic API behavior and comply with types */
  req.userId = session?.user?.id || -1;

  const trace = tracerProvider.getTracer("cal.com");
  const span = trace.startSpan("book-event-api-handler");

  const booking = await handleNewBooking(req);

  span.end();

  return booking;
}

export default defaultResponder(handler);
