import { BookingStatus, Credential, SelectedCalendar } from "@prisma/client";

import { getBusyCalendarTimes } from "@calcom/core/CalendarManager";
import dayjs, { Dayjs } from "@calcom/dayjs";
import logger from "@calcom/lib/logger";
import { performance } from "@calcom/lib/server/perfObserver";
import prisma from "@calcom/prisma";
import type { EventBusyDetails } from "@calcom/types/Calendar";

export type BusyTimes = {
  start: Dayjs;
  end: Dayjs;
  title?: string;
  source?: string | null;
};

export type BusyTimesWithUser = BusyTimes & {
  userId: number | null;
};

type EventBusyDetailsWithUser = EventBusyDetails & {
  userId: number | null;
};

type BusyTimesByUserAndDay = Record<number, Record<string, BusyTimes[]>>;

export async function getBusyTimesByUserAndDay(params: {
  users: { id: number; credentials: Credential[]; selectedCalendars: SelectedCalendar[] }[];
  startTime: string;
  endTime: string;
}): Promise<BusyTimesByUserAndDay> {
  const { startTime, endTime, users } = params;
  const dbBusyTimes = await busyTimesFromDb({
    userIds: users.map((u) => u.id),
    startTime: startTime,
    endTime: endTime,
  });

  const calendarBusyTimes = await Promise.all(
    users.map((u) => {
      return getBusyCalendarTimes(u.credentials, startTime, endTime, u.selectedCalendars).then((busy) => {
        return busy.map((b) => ({ ...b, userId: u.id }));
      });
    })
  );

  const allBusyTimes = dbBusyTimes.concat(calendarBusyTimes.flat()).map((busy) => ({
    ...busy,
    start: dayjs(busy.start).utc(),
    end: dayjs(busy.end).utc(),
  }));

  // Convert the array of busy times into an efficient data structure that can be indexed by user and day
  // Example: busyTimes[userId][date] => [busyTime1, busyTime2, ...]
  return allBusyTimes.reduce((acc, busy) => {
    if (!busy.userId) {
      return acc;
    }

    if (!acc[busy.userId]) {
      acc[busy.userId] = {};
    }

    // busy times can span multiple days, so we need to add a busy time for each day.
    let current = busy.start;
    while (current.isSameOrBefore(busy.end, "day")) {
      const key = current.format("YYYY-MM-DD");
      if (!acc[busy.userId][key]) {
        acc[busy.userId][key] = [];
      }
      acc[busy.userId][key].push(busy);
      current = current.add(1, "day");
    }

    return acc;
  }, {} as BusyTimesByUserAndDay);
}

// currently unused. getBusyTimesByUserAndDay is used instead.
export async function getBufferedBusyTimes(params: {
  credentials: Credential[];
  userId: number;
  eventTypeId?: number;
  startTime: string;
  endTime: string;
  selectedCalendars: SelectedCalendar[];
  userBufferTime: number;
  afterEventBuffer?: number;
}): Promise<BusyTimes[]> {
  const busy = await getBusyTimes({
    credentials: params.credentials,
    userId: params.userId,
    eventTypeId: params.eventTypeId,
    startTime: params.startTime,
    endTime: params.endTime,
    selectedCalendars: params.selectedCalendars,
  });
  return busy.map((a) => ({
    ...a,
    start: dayjs(a.start).subtract(params.userBufferTime, "minute"),
    end: dayjs(a.end).add(params.userBufferTime + (params.afterEventBuffer || 0), "minute"),
    title: a.title,
  }));
}

export async function getBusyTimes(params: {
  credentials: Credential[];
  userId: number;
  eventTypeId?: number;
  startTime: string;
  beforeEventBuffer?: number;
  afterEventBuffer?: number;
  endTime: string;
  selectedCalendars: SelectedCalendar[];
}) {
  const {
    credentials,
    userId,
    eventTypeId,
    startTime,
    endTime,
    selectedCalendars,
    beforeEventBuffer,
    afterEventBuffer,
  } = params;
  logger.silly(
    `Checking Busy time from Cal Bookings in range ${startTime} to ${endTime} for input ${JSON.stringify({
      userId,
      eventTypeId,
      status: BookingStatus.ACCEPTED,
    })}`
  );
  performance.mark("prismaBookingGetStart");
  const busyTimes: EventBusyDetails[] = await prisma.booking
    .findMany({
      where: {
        userId,
        startTime: { gte: new Date(startTime) },
        endTime: { lte: new Date(endTime) },
        status: {
          in: [BookingStatus.ACCEPTED],
        },
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        title: true,
        eventType: {
          select: {
            id: true,
            afterEventBuffer: true,
            beforeEventBuffer: true,
          },
        },
      },
    })
    .then((bookings) =>
      bookings.map(({ startTime, endTime, title, id, eventType }) => ({
        start: dayjs(startTime)
          .subtract((eventType?.beforeEventBuffer || 0) + (afterEventBuffer || 0), "minute")
          .toDate(),
        end: dayjs(endTime)
          .add((eventType?.afterEventBuffer || 0) + (beforeEventBuffer || 0), "minute")
          .toDate(),
        title,
        source: `eventType-${eventType?.id}-booking-${id}`,
      }))
    );
  logger.silly(`Busy Time from Cal Bookings ${JSON.stringify(busyTimes)}`);
  performance.mark("prismaBookingGetEnd");
  performance.measure(`prisma booking get took $1'`, "prismaBookingGetStart", "prismaBookingGetEnd");
  if (credentials?.length > 0) {
    const calendarBusyTimes = await getBusyCalendarTimes(credentials, startTime, endTime, selectedCalendars);
    busyTimes.push(
      ...calendarBusyTimes.map((value) => ({
        ...value,
        end: dayjs(value.end)
          .add(beforeEventBuffer || 0, "minute")
          .toDate(),
        start: dayjs(value.start)
          .subtract(afterEventBuffer || 0, "minute")
          .toDate(),
      }))
    );

    /*
    // TODO: Disabled until we can filter Zoom events by date. Also this is adding too much latency.
    const videoBusyTimes = (await getBusyVideoTimes(credentials)).filter(notEmpty);
    console.log("videoBusyTimes", videoBusyTimes);
    busyTimes.push(...videoBusyTimes);
    */
  }
  return busyTimes;
}

async function busyTimesFromDb(params: {
  userIds: number[];
  startTime: string;
  endTime: string;
}): Promise<EventBusyDetailsWithUser[]> {
  const { userIds, startTime, endTime } = params;
  return prisma.booking
    .findMany({
      where: {
        userId: {
          in: userIds,
        },
        startTime: { gte: new Date(startTime) },
        endTime: { lte: new Date(endTime) },
        status: BookingStatus.ACCEPTED,
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        title: true,
        userId: true,
        eventTypeId: true,
      },
    })
    .then((bookings) =>
      bookings.map(({ startTime, endTime, title, id, eventTypeId, userId }) => ({
        start: startTime,
        end: endTime,
        title,
        source: `eventType-${eventTypeId}-booking-${id}`,
        userId,
      }))
    );
}

export default getBusyTimes;
