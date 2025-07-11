import {
  BookingStatus,
  Credential,
  EventTypeCustomInput,
  Prisma,
  SchedulingType,
  WebhookTriggerEvents,
} from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import async from "async";
import { isValidPhoneNumber } from "libphonenumber-js";
import { cloneDeep } from "lodash";
import type { NextApiRequest } from "next";
import short from "short-uuid";
import { v5 as uuidv5 } from "uuid";
import z from "zod";

import { metadata as GoogleMeetMetadata } from "@calcom/app-store/googlevideo/_metadata";
import { getLocationValueForDB, LocationObject } from "@calcom/app-store/locations";
import { MeetLocationType } from "@calcom/app-store/locations";
import { handleEthSignature } from "@calcom/app-store/rainbow/utils/ethereum";
import { handlePayment } from "@calcom/app-store/stripepayment/lib/server";
import { getEventTypeAppData } from "@calcom/app-store/utils";
import { cancelScheduledJobs, scheduleTrigger } from "@calcom/app-store/zapier/lib/nodeScheduler";
import EventManager from "@calcom/core/EventManager";
import { getEventName } from "@calcom/core/event";
import { getUserAvailability } from "@calcom/core/getUserAvailability";
import dayjs from "@calcom/dayjs";
import {
  sendAttendeeRequestEmail,
  sendOrganizerRequestEmail,
  sendRescheduledEmails,
  sendScheduledEmails,
  sendScheduledSeatsEmails,
} from "@calcom/emails";
import { scheduleWorkflowReminders } from "@calcom/features/ee/workflows/lib/reminders/reminderScheduler";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import { isPrismaObjOrUndefined, parseRecurringEvent } from "@calcom/lib";
import { getDefaultEvent, getUsernameList } from "@calcom/lib/defaultEvents";
import { getErrorFromUnknown } from "@calcom/lib/errors";
import getStripeAppData from "@calcom/lib/getStripeAppData";
import { HttpError } from "@calcom/lib/http-error";
import isOutOfBounds, { BookingDateInPastError } from "@calcom/lib/isOutOfBounds";
import logger from "@calcom/lib/logger";
import { checkBookingLimits } from "@calcom/lib/server";
import { getTranslation } from "@calcom/lib/server/i18n";
import { updateWebUser as syncServicesUpdateWebUser } from "@calcom/lib/sync/SyncServiceManager";
import prisma, { userSelect } from "@calcom/prisma";
import {
  customInputSchema,
  EventTypeMetaDataSchema,
  extendedBookingCreateBody,
} from "@calcom/prisma/zod-utils";
import type { BufferedBusyTime } from "@calcom/types/BufferedBusyTime";
import type { AdditionalInformation, AppsStatus, CalendarEvent } from "@calcom/types/Calendar";
import type { EventResult, PartialReference } from "@calcom/types/EventManager";

import sendPayload, { EventTypeInfo } from "../../webhooks/lib/sendPayload";

const translator = short();
const log = logger.getChildLogger({ prefix: ["[api] book:user"] });

type User = Prisma.UserGetPayload<typeof userSelect>;
type BufferedBusyTimes = BufferedBusyTime[];

/**
 * Refreshes a Credential with fresh data from the database.
 *
 * @param credential
 */
async function refreshCredential(credential: Credential): Promise<Credential> {
  const newCredential = await prisma.credential.findUnique({
    where: {
      id: credential.id,
    },
  });

  if (!newCredential) {
    return credential;
  } else {
    return newCredential;
  }
}

/**
 * Refreshes the given set of credentials.
 *
 * @param credentials
 */
async function refreshCredentials(credentials: Array<Credential>): Promise<Array<Credential>> {
  return await async.mapLimit(credentials, 5, refreshCredential);
}

function isAvailable(busyTimes: BufferedBusyTimes, time: dayjs.ConfigType, length: number): boolean {
  // Check for conflicts
  let t = true;

  // Early return
  if (!Array.isArray(busyTimes) || busyTimes.length < 1) return t;

  let i = 0;
  while (t === true && i < busyTimes.length) {
    const busyTime = busyTimes[i];
    i++;
    const startTime = dayjs(busyTime.start);
    const endTime = dayjs(busyTime.end);

    // Check if time is between start and end times
    if (dayjs(time).isBetween(startTime, endTime, null, "[)")) {
      t = false;
      break;
    }

    // Check if slot end time is between start and end time
    if (dayjs(time).add(length, "minutes").isBetween(startTime, endTime)) {
      t = false;
      break;
    }

    // Check if startTime is between slot
    if (startTime.isBetween(dayjs(time), dayjs(time).add(length, "minutes"))) {
      t = false;
      break;
    }
  }

  return t;
}

const getEventTypesFromDB = async (eventTypeId: number) => {
  const eventType = await prisma.eventType.findUniqueOrThrow({
    where: {
      id: eventTypeId,
    },
    select: {
      id: true,
      customInputs: true,
      users: userSelect,
      team: {
        select: {
          id: true,
          name: true,
        },
      },
      title: true,
      length: true,
      eventName: true,
      schedulingType: true,
      description: true,
      periodType: true,
      periodStartDate: true,
      periodEndDate: true,
      periodDays: true,
      periodCountCalendarDays: true,
      requiresConfirmation: true,
      userId: true,
      price: true,
      currency: true,
      metadata: true,
      destinationCalendar: true,
      hideCalendarNotes: true,
      seatsPerTimeSlot: true,
      recurringEvent: true,
      seatsShowAttendees: true,
      bookingLimits: true,
      workflows: {
        include: {
          workflow: {
            include: {
              steps: true,
            },
          },
        },
      },
      locations: true,
      timeZone: true,
      schedule: {
        select: {
          availability: true,
          timeZone: true,
        },
      },
      availability: {
        select: {
          date: true,
          startTime: true,
          endTime: true,
          days: true,
        },
      },
    },
  });

  return {
    ...eventType,
    metadata: EventTypeMetaDataSchema.parse(eventType.metadata),
    recurringEvent: parseRecurringEvent(eventType.recurringEvent),
    customInputs: customInputSchema.array().parse(eventType.customInputs),
    locations: (eventType.locations ?? []) as LocationObject[],
  };
};

async function ensureAvailableUsers(
  eventType: Awaited<ReturnType<typeof getEventTypesFromDB>> & {
    users: User[];
  },
  input: { dateFrom: string; dateTo: string },
  recurringDatesInfo?: {
    allRecurringDates: string[] | undefined;
    currentRecurringIndex: number | undefined;
  }
) {
  const availableUsers: typeof eventType.users = [];
  /** Let's start checking for availability */
  for (const user of eventType.users) {
    const { busy: bufferedBusyTimes } = await getUserAvailability(
      {
        userId: user.id,
        eventTypeId: eventType.id,
        ...input,
      },
      { user, eventType }
    );

    let isAvailableToBeBooked = true;
    try {
      if (
        eventType.recurringEvent &&
        recurringDatesInfo?.currentRecurringIndex === 0 &&
        recurringDatesInfo.allRecurringDates
      ) {
        const allBookingDates = recurringDatesInfo.allRecurringDates.map((strDate) => new Date(strDate));
        // Go through each date for the recurring event and check if each one's availability
        // DONE: Decreased computational complexity from O(2^n) to O(n) by refactoring this loop to stop
        // running at the first unavailable time.
        let i = 0;
        while (isAvailableToBeBooked === true && i < allBookingDates.length) {
          const aDate = allBookingDates[i];
          i++;
          isAvailableToBeBooked = isAvailable(bufferedBusyTimes, aDate, eventType.length);
          // We bail at the first false, we don't need to keep checking
          if (!isAvailableToBeBooked) break;
        }
      } else {
        isAvailableToBeBooked = isAvailable(bufferedBusyTimes, input.dateFrom, eventType.length);
      }
    } catch (e) {
      log.debug({
        message: "Unable set isAvailableToBeBooked. Using true. ",
      });
      Sentry.captureException(e);
    }

    if (isAvailableToBeBooked) {
      availableUsers.push(user);
      return availableUsers;
    }
  }
  if (!availableUsers.length) {
    throw new HttpError({ statusCode: 409, message: "No available users found." });
  }
  return availableUsers;
}

async function handler(req: NextApiRequest & { userId?: number | undefined }) {
  const { userId } = req;

  const {
    recurringCount,
    allRecurringDates,
    currentRecurringIndex,
    noEmail,
    eventTypeSlug,
    eventTypeId,
    hasHashedBookingLink,
    language,
    appsStatus: reqAppsStatus,
    ...reqBody
  } = extendedBookingCreateBody.parse(req.body);

  if (userId && userId !== -1) {
    // Add the currently logged in user's ID to the metadata. Just for debugging.
    reqBody.metadata.bookedByUser = userId.toString();
  }

  // reqBody.user can be a string or an array of strings
  const userList = getUsernameList(reqBody.user);
  const tAttendees = await getTranslation(language ?? "en", "common");
  const tGuests = await getTranslation("en", "common");
  log.debug(`Booking eventType ${eventTypeId} started`);

  const eventType =
    !eventTypeId && !!eventTypeSlug ? getDefaultEvent(eventTypeSlug) : await getEventTypesFromDB(eventTypeId);

  if (!eventType) throw new HttpError({ statusCode: 404, message: "eventType.notFound" });

  const stripeAppData = getStripeAppData(eventType);

  // Check if required custom inputs exist
  handleCustomInputs(eventType.customInputs as EventTypeCustomInput[], reqBody.customInputs);

  let timeOutOfBounds = false;
  try {
    timeOutOfBounds = isOutOfBounds(reqBody.start, {
      periodType: eventType.periodType,
      periodDays: eventType.periodDays,
      periodEndDate: eventType.periodEndDate,
      periodStartDate: eventType.periodStartDate,
      periodCountCalendarDays: eventType.periodCountCalendarDays,
    });
  } catch (error) {
    if (error instanceof BookingDateInPastError) {
      // TODO: HttpError should not bleed through to the console.
      log.info(`Booking eventType ${eventTypeId} failed`, error);
      throw new HttpError({ statusCode: 400, message: error.message });
    }
    log.debug({
      message: "Unable set timeOutOfBounds. Using false. ",
    });
    Sentry.captureException(error);
  }

  if (timeOutOfBounds) {
    const error = {
      errorCode: "BookingTimeOutOfBounds",
      message: `EventType '${eventType.eventName}' cannot be booked at this time.`,
    };

    throw new HttpError({ statusCode: 400, message: error.message });
  }

  let users =
    userList.length > 0
      ? await prisma.user.findMany({
          where: {
            username: {
              in: userList,
            },
          },
          ...userSelect,
        })
      : eventType.users;

  // Used to order the users returned from the database.
  const userOrderMap = userList.reduce((acc, username, index) => {
    acc[username] = index;
    return acc;
  }, {} as Record<string, number>);

  // users should have same order as userList
  users = users.sort((a, b) => {
    if (a.username === null || b.username === null) {
      return 0;
    }
    return (userOrderMap[a.username] ?? 0) - (userOrderMap[b.username] ?? 0);
  });

  const isDynamicAllowed = !users.some((user) => !user.allowDynamicBooking);
  if (!isDynamicAllowed && !eventTypeId) {
    throw new HttpError({
      message: "Some of the users in this group do not allow dynamic booking",
      statusCode: 400,
    });
  }

  // If this event was pre-relationship migration
  // TODO: Establish whether this is dead code.
  if (!users.length && eventType.userId) {
    const eventTypeUser = await prisma.user.findUnique({
      where: {
        id: eventType.userId,
      },
      ...userSelect,
    });
    if (!eventTypeUser) throw new HttpError({ statusCode: 404, message: "eventTypeUser.notFound" });
    users.push(eventTypeUser);
  }

  if (!users) throw new HttpError({ statusCode: 404, message: "eventTypeUser.notFound" });

  if (eventType && eventType.hasOwnProperty("bookingLimits") && eventType?.bookingLimits) {
    const startAsDate = dayjs(reqBody.start).toDate();
    await checkBookingLimits(eventType.bookingLimits, startAsDate, eventType.id);
  }

  if (!eventType.seatsPerTimeSlot) {
    const availableUsers = await ensureAvailableUsers(
      {
        ...eventType,
        users,
        ...(eventType.recurringEvent && {
          recurringEvent: {
            ...eventType.recurringEvent,
            count: recurringCount || eventType.recurringEvent.count,
          },
        }),
      },
      {
        dateFrom: reqBody.start,
        dateTo: reqBody.end,
      },
      {
        allRecurringDates,
        currentRecurringIndex,
      }
    );

    // Add an if conditional if there are no seats on the event type
    // Assign to only one user when ROUND_ROBIN
    if (eventType.schedulingType === SchedulingType.ROUND_ROBIN) {
      // users = [await getLuckyUser("MAXIMIZE_AVAILABILITY", { availableUsers, eventTypeId: eventType.id })];
      users = availableUsers.length > 0 ? availableUsers : eventType.users;
    } else {
      // excluding ROUND_ROBIN, all users have availability required.
      if (availableUsers.length !== users.length) {
        throw new Error("Some users are unavailable for booking.");
      }
      users = availableUsers;
    }
  }
  const rainbowAppData = getEventTypeAppData(eventType, "rainbow") || {};

  // @TODO: use the returned address somewhere in booking creation?
  // const address: string | undefined = await ...
  await handleEthSignature(rainbowAppData, reqBody.ethSignature);

  const [organizerUser] = users;
  const tOrganizer = await getTranslation(organizerUser.locale ?? "en", "common");

  const invitee = [
    {
      email: reqBody.email,
      name: reqBody.name,
      timeZone: reqBody.timeZone,
      language: { translate: tAttendees, locale: language ?? "en" },
    },
  ];
  const guests = (reqBody.guests || []).map((guest) => ({
    email: guest,
    name: "",
    timeZone: reqBody.timeZone,
    language: { translate: tGuests, locale: "en" },
  }));

  const seed = `${organizerUser.username}:${dayjs(reqBody.start).utc().format()}:${new Date().getTime()}`;
  const uid = translator.fromUUID(uuidv5(seed, uuidv5.URL));

  const bookingLocation = getLocationValueForDB(reqBody.location, eventType.locations);
  const customInputs = {} as NonNullable<CalendarEvent["customInputs"]>;

  const teamMemberPromises =
    eventType.schedulingType === SchedulingType.COLLECTIVE
      ? users.slice(1).map(async function (user) {
          return {
            email: user.email || "",
            name: user.name || "",
            timeZone: user.timeZone,
            language: {
              translate: await getTranslation(user.locale ?? "en", "common"),
              locale: user.locale ?? "en",
            },
          };
        })
      : [];

  const teamMembers = await Promise.all(teamMemberPromises);

  const attendeesList = [...invitee, ...guests, ...teamMembers];

  const eventNameObject = {
    attendeeName: reqBody.name || "Nameless",
    eventType: eventType.title,
    eventName: eventType.eventName,
    host: organizerUser.name || "Nameless",
    location: bookingLocation,
    t: tOrganizer,
  };

  const additionalNotes = reqBody.notes;

  let requiresConfirmation = eventType?.requiresConfirmation;
  const rcThreshold = eventType?.metadata?.requiresConfirmationThreshold;
  if (rcThreshold) {
    if (dayjs(dayjs(reqBody.start).utc().format()).diff(dayjs(), rcThreshold.unit) > rcThreshold.time) {
      requiresConfirmation = false;
    }
  }

  let evt: CalendarEvent = {
    type: eventType.title,
    title: getEventName(eventNameObject), //this needs to be either forced in english, or fetched for each attendee and organizer separately
    description: eventType.description,
    additionalNotes,
    customInputs,
    startTime: dayjs(reqBody.start).utc().format(),
    endTime: dayjs(reqBody.end).utc().format(),
    organizer: {
      id: organizerUser.id,
      name: organizerUser.name || "Nameless",
      email: organizerUser.email || "Email-less",
      timeZone: organizerUser.timeZone,
      language: { translate: tOrganizer, locale: organizerUser.locale ?? "en" },
    },
    attendees: attendeesList,
    location: bookingLocation, // Will be processed by the EventManager later.
    /** For team events & dynamic collective events, we will need to handle each member destinationCalendar eventually */
    destinationCalendar: eventType.destinationCalendar || organizerUser.destinationCalendar,
    hideCalendarNotes: eventType.hideCalendarNotes,
    requiresConfirmation: requiresConfirmation ?? false,
    eventTypeId: eventType.id,
    seatsShowAttendees: !!eventType.seatsShowAttendees,
    seatsPerTimeSlot: eventType.seatsPerTimeSlot,
  };

  // For seats, if the booking already exists then we want to add the new attendee to the existing booking
  if (reqBody.bookingUid) {
    if (!eventType.seatsPerTimeSlot)
      throw new HttpError({ statusCode: 404, message: "Event type does not have seats" });

    const booking = await prisma.booking.findUnique({
      where: {
        uid: reqBody.bookingUid,
      },
      select: {
        uid: true,
        id: true,
        attendees: true,
        userId: true,
        references: true,
        startTime: true,
        user: true,
      },
    });
    if (!booking) throw new HttpError({ statusCode: 404, message: "Booking not found" });

    // Need to add translation for attendees to pass type checks. Since these values are never written to the db we can just use the new attendee language
    const bookingAttendees = booking.attendees.map((attendee) => {
      return { ...attendee, language: { translate: tAttendees, locale: language ?? "en" } };
    });

    evt = { ...evt, attendees: [...bookingAttendees, invitee[0]] };

    if (eventType.seatsPerTimeSlot <= booking.attendees.length)
      throw new HttpError({ statusCode: 409, message: "Booking seats are full" });

    if (booking.attendees.some((attendee) => attendee.email === invitee[0].email))
      throw new HttpError({ statusCode: 409, message: "Already signed up for time slot" });

    const videoCallReference = booking.references.find((reference) => reference.type.includes("_video"));

    if (videoCallReference) {
      evt.videoCallData = {
        type: videoCallReference.type,
        id: videoCallReference.meetingId,
        password: videoCallReference?.meetingPassword,
        url: videoCallReference.meetingUrl,
      };
    }
    await prisma.booking.update({
      where: {
        uid: reqBody.bookingUid,
      },
      data: {
        attendees: {
          create: {
            email: invitee[0].email,
            name: invitee[0].name,
            timeZone: invitee[0].timeZone,
            locale: invitee[0].language.locale,
          },
        },
      },
    });

    const newSeat = booking.attendees.length !== 0;

    /**
     * Remember objects are passed into functions as references
     * so if you modify it in a inner function it will be modified in the outer function
     * deep cloning evt to avoid this
     */
    const copyEvent = cloneDeep(evt);
    await sendScheduledSeatsEmails(copyEvent, invitee[0], newSeat, !!eventType.seatsShowAttendees);

    const credentials = await refreshCredentials(organizerUser.credentials);
    const eventManager = new EventManager({ ...organizerUser, credentials });
    await eventManager.updateCalendarAttendees(evt, booking);

    if (!Number.isNaN(stripeAppData.price) && stripeAppData.price > 0 && !!booking) {
      const [firstStripeCredential] = organizerUser.credentials.filter(
        (cred) => cred.type == "stripe_payment"
      );

      if (!firstStripeCredential)
        throw new HttpError({ statusCode: 400, message: "Missing payment credentials" });

      const payment = await handlePayment(evt, eventType, firstStripeCredential, booking);

      req.statusCode = 201;
      return { ...booking, message: "Payment required", paymentUid: payment.uid };
    }

    req.statusCode = 201;
    return booking;
  }

  if (reqBody.customInputs.length > 0) {
    reqBody.customInputs.forEach(({ label, value }) => {
      customInputs[label] = value;
    });
  }

  if (eventType.schedulingType === SchedulingType.COLLECTIVE) {
    evt.team = {
      members: users.map((user) => user.name || user.username || "Nameless"),
      name: eventType.team?.name || "Nameless",
    }; // used for invitee emails
  }

  if (reqBody.recurringEventId && eventType.recurringEvent) {
    // Overriding the recurring event configuration count to be the actual number of events booked for
    // the recurring event (equal or less than recurring event configuration count)
    eventType.recurringEvent = Object.assign({}, eventType.recurringEvent, { count: recurringCount });
    evt.recurringEvent = eventType.recurringEvent;
  }

  // Initialize EventManager with credentials
  const rescheduleUid = reqBody.rescheduleUid;
  async function getOriginalRescheduledBooking(uid: string) {
    return prisma.booking.findFirst({
      where: {
        uid,
        status: {
          in: [BookingStatus.ACCEPTED, BookingStatus.CANCELLED, BookingStatus.PENDING],
        },
      },
      include: {
        attendees: {
          select: {
            name: true,
            email: true,
            locale: true,
            timeZone: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            locale: true,
            timeZone: true,
          },
        },
        payment: true,
      },
    });
  }
  type BookingType = Prisma.PromiseReturnType<typeof getOriginalRescheduledBooking>;
  let originalRescheduledBooking: BookingType = null;
  if (rescheduleUid) {
    originalRescheduledBooking = await getOriginalRescheduledBooking(rescheduleUid);
  }
  // If the user is not the owner of the event, new booking should be always pending.
  // Otherwise, an owner rescheduling should be always accepted.
  // Before comparing make sure that userId is set, otherwise undefined === undefined
  const userReschedulingIsOwner = userId && originalRescheduledBooking?.user?.id === userId;
  const isConfirmedByDefault = (!requiresConfirmation && !stripeAppData.price) || userReschedulingIsOwner;

  async function createBooking() {
    if (originalRescheduledBooking) {
      evt.title = evt.title;
      evt.description = evt.additionalNotes;
      evt.location = originalRescheduledBooking?.location;
    }

    const eventTypeRel = !eventTypeId
      ? {}
      : {
          connect: {
            id: eventTypeId,
          },
        };

    const dynamicEventSlugRef = !eventTypeId ? eventTypeSlug : null;
    const dynamicGroupSlugRef = !eventTypeId ? (reqBody.user as string).toLowerCase() : null;

    const newBookingData: Prisma.BookingCreateInput = {
      uid,
      title: evt.title,
      startTime: dayjs.utc(evt.startTime).toDate(),
      endTime: dayjs.utc(evt.endTime).toDate(),
      description: evt.additionalNotes,
      customInputs: isPrismaObjOrUndefined(evt.customInputs),
      status: isConfirmedByDefault ? BookingStatus.ACCEPTED : BookingStatus.PENDING,
      location: evt.location,
      eventType: eventTypeRel,
      smsReminderNumber: reqBody.smsReminderNumber,
      metadata: reqBody.metadata,
      attendees: {
        createMany: {
          data: evt.attendees.map((attendee) => {
            //if attendee is team member, it should fetch their locale not booker's locale
            //perhaps make email fetch request to see if his locale is stored, else
            const retObj = {
              name: attendee.name,
              email: attendee.email,
              timeZone: attendee.timeZone,
              locale: attendee.language.locale,
            };
            return retObj;
          }),
        },
      },
      dynamicEventSlugRef,
      dynamicGroupSlugRef,
      user: {
        connect: {
          id: organizerUser.id,
        },
      },
      destinationCalendar: evt.destinationCalendar
        ? {
            connect: { id: evt.destinationCalendar.id },
          }
        : undefined,
    };
    if (reqBody.recurringEventId) {
      newBookingData.recurringEventId = reqBody.recurringEventId;
    }
    if (originalRescheduledBooking) {
      newBookingData["paid"] = originalRescheduledBooking.paid;
      newBookingData["fromReschedule"] = originalRescheduledBooking.uid;
      if (newBookingData.attendees?.createMany?.data) {
        newBookingData.attendees.createMany.data = originalRescheduledBooking.attendees;
      }
      if (originalRescheduledBooking.recurringEventId) {
        newBookingData.recurringEventId = originalRescheduledBooking.recurringEventId;
      }
    }
    const createBookingObj = {
      include: {
        user: {
          select: { email: true, name: true, timeZone: true },
        },
        attendees: true,
        payment: true,
      },
      data: newBookingData,
    };

    if (originalRescheduledBooking?.paid && originalRescheduledBooking?.payment) {
      const bookingPayment = originalRescheduledBooking?.payment?.find((payment) => payment.success);

      if (bookingPayment) {
        createBookingObj.data.payment = {
          connect: { id: bookingPayment.id },
        };
      }
    }

    if (typeof stripeAppData.price === "number" && stripeAppData.price > 0) {
      /* Validate if there is any stripe_payment credential for this user */
      /*  note: removes custom error message about stripe */
      await prisma.credential.findFirstOrThrow({
        where: {
          type: "stripe_payment",
          userId: organizerUser.id,
        },
        select: {
          id: true,
        },
      });
    }

    return prisma.booking.create(createBookingObj);
  }

  let results: EventResult<AdditionalInformation>[] = [];
  let referencesToCreate: PartialReference[] = [];

  type Booking = Prisma.PromiseReturnType<typeof createBooking>;
  let booking: (Booking & { appsStatus?: AppsStatus[] }) | null = null;
  try {
    booking = await createBooking();
    // Sync Services
    await syncServicesUpdateWebUser(
      await prisma.user.findFirst({
        where: { id: userId },
        select: { id: true, email: true, name: true, username: true, createdDate: true },
      })
    );
    evt.uid = booking?.uid ?? null;
  } catch (_err) {
    const err = getErrorFromUnknown(_err);
    log.error(`Booking ${eventTypeId} failed`, "Error when saving booking to db", err.message);

    Sentry.captureException(err);

    if (err.code === "P2002") {
      throw new HttpError({ statusCode: 409, message: "booking.conflict" });
    }
    throw err;
  }

  // After polling videoBusyTimes, credentials might have been changed due to refreshment, so query them again.
  const credentials = await refreshCredentials(organizerUser.credentials);
  const eventManager = new EventManager({ ...organizerUser, credentials });

  function handleAppsStatus(
    results: EventResult<AdditionalInformation>[],
    booking: (Booking & { appsStatus?: AppsStatus[] }) | null
  ) {
    // Taking care of apps status
    const resultStatus: AppsStatus[] = results.map((app) => ({
      appName: app.appName,
      type: app.type,
      success: app.success ? 1 : 0,
      failures: !app.success ? 1 : 0,
      errors: app.calError ? [app.calError] : [],
      warnings: app.calWarnings,
    }));

    if (reqAppsStatus === undefined) {
      if (booking !== null) {
        booking.appsStatus = resultStatus;
      }
      evt.appsStatus = resultStatus;
      return;
    }
    // From down here we can assume reqAppsStatus is not undefined anymore
    // Other status exist, so this is the last booking of a series,
    // proceeding to prepare the info for the event
    const calcAppsStatus = reqAppsStatus.concat(resultStatus).reduce((prev, curr) => {
      if (prev[curr.type]) {
        prev[curr.type].success += curr.success;
        prev[curr.type].errors = prev[curr.type].errors.concat(curr.errors);
        prev[curr.type].warnings = prev[curr.type].warnings?.concat(curr.warnings || []);
      } else {
        prev[curr.type] = curr;
      }
      return prev;
    }, {} as { [key: string]: AppsStatus });
    evt.appsStatus = Object.values(calcAppsStatus);
  }

  let videoCallUrl;

  if (originalRescheduledBooking?.uid) {
    // Use EventManager to conditionally use all needed integrations.
    const updateManager = await eventManager.reschedule(
      evt,
      originalRescheduledBooking.uid,
      booking?.id,
      reqBody.rescheduleReason
    );
    // This gets overridden when updating the event - to check if notes have been hidden or not. We just reset this back
    // to the default description when we are sending the emails.
    evt.description = eventType.description;

    results = updateManager.results;
    referencesToCreate = updateManager.referencesToCreate;
    if (results.length > 0 && results.some((res) => !res.success)) {
      const error = {
        errorCode: "BookingReschedulingMeetingFailed",
        message: "Booking Rescheduling failed",
      };

      log.error(`Booking ${organizerUser.name} failed`, error, results);
    } else {
      const metadata: AdditionalInformation = {};

      if (results.length) {
        // TODO: Handle created event metadata more elegantly
        const [updatedEvent] = Array.isArray(results[0].updatedEvent)
          ? results[0].updatedEvent
          : [results[0].updatedEvent];
        if (updatedEvent) {
          metadata.hangoutLink = updatedEvent.hangoutLink;
          metadata.conferenceData = updatedEvent.conferenceData;
          metadata.entryPoints = updatedEvent.entryPoints;
        }
        // A reschedule can create a new event if rescheduled with a different user
        const createdEvent = results[0].createdEvent;
        if (createdEvent) {
          metadata.hangoutLink = createdEvent.hangoutLink;
          metadata.conferenceData = createdEvent.conferenceData;
          metadata.entryPoints = createdEvent.entryPoints;
        }

        if (createdEvent || updatedEvent) {
          handleAppsStatus(results, booking);
          videoCallUrl = metadata.hangoutLink || videoCallUrl;
        }
      }
      if (noEmail !== true) {
        await sendRescheduledEmails({
          ...evt,
          additionalInformation: metadata,
          additionalNotes, // Resets back to the additionalNote input and not the override value
          cancellationReason: "$RCH$" + reqBody.rescheduleReason, // Removable code prefix to differentiate cancellation from rescheduling for email
        });
      }
    }
    // If it's not a reschedule, doesn't require confirmation and there's no price,
    // Create a booking
  } else if (!requiresConfirmation && !stripeAppData.price) {
    // Use EventManager to conditionally use all needed integrations.
    const createManager = await eventManager.create(evt);

    // This gets overridden when creating the event - to check if notes have been hidden or not. We just reset this back
    // to the default description when we are sending the emails.
    evt.description = eventType.description;

    results = createManager.results;
    referencesToCreate = createManager.referencesToCreate;

    videoCallUrl = evt.videoCallData && evt.videoCallData.url ? evt.videoCallData.url : null;

    if (results.length > 0 && results.every((res) => !res.success)) {
      const error = {
        errorCode: "BookingCreatingMeetingFailed",
        message: "Booking failed",
      };

      log.error(`Booking ${organizerUser.username} failed`, error, results);
    } else {
      const metadata: AdditionalInformation = {};

      if (results.length) {
        // Handle Google Meet results
        // We use the original booking location since the evt location changes to daily
        if (bookingLocation === MeetLocationType) {
          const googleMeetResult = {
            appName: GoogleMeetMetadata.name,
            type: "conferencing",
            uid: results[0].uid,
            originalEvent: results[0].originalEvent,
          };

          const googleCalResult = results.find((result) => result.type === "google_calendar");

          if (!googleCalResult) {
            results.push({
              ...googleMeetResult,
              success: false,
              calWarnings: [tOrganizer("google_meet_warning")],
            });
          }

          if (googleCalResult?.createdEvent?.hangoutLink) {
            results.push({
              ...googleMeetResult,
              success: true,
            });
          } else if (googleCalResult && !googleCalResult.createdEvent?.hangoutLink) {
            results.push({
              ...googleMeetResult,
              success: false,
            });
          }
        }
        // TODO: Handle created event metadata more elegantly
        metadata.hangoutLink = results[0].createdEvent?.hangoutLink;
        metadata.conferenceData = results[0].createdEvent?.conferenceData;
        metadata.entryPoints = results[0].createdEvent?.entryPoints;
        handleAppsStatus(results, booking);
        videoCallUrl = metadata.hangoutLink || videoCallUrl;
      }
      if (noEmail !== true) {
        await sendScheduledEmails({
          ...evt,
          additionalInformation: metadata,
          additionalNotes,
          customInputs,
        });
      }
    }
  }

  if (!isConfirmedByDefault && noEmail !== true) {
    await sendOrganizerRequestEmail({ ...evt, additionalNotes });
    await sendAttendeeRequestEmail({ ...evt, additionalNotes }, attendeesList[0]);
  }

  if (
    !Number.isNaN(stripeAppData.price) &&
    stripeAppData.price > 0 &&
    !originalRescheduledBooking?.paid &&
    !!booking
  ) {
    const [firstStripeCredential] = organizerUser.credentials.filter((cred) => cred.type == "stripe_payment");

    if (!firstStripeCredential)
      throw new HttpError({ statusCode: 400, message: "Missing payment credentials" });

    if (!booking.user) booking.user = organizerUser;
    const payment = await handlePayment(evt, eventType, firstStripeCredential, booking);

    req.statusCode = 201;
    return { ...booking, message: "Payment required", paymentUid: payment.uid };
  }

  log.debug(`Booking ${organizerUser.username} completed`);
  const metadata = videoCallUrl ? { videoCallUrl } : undefined;
  if (isConfirmedByDefault) {
    const eventTrigger: WebhookTriggerEvents = rescheduleUid
      ? WebhookTriggerEvents.BOOKING_RESCHEDULED
      : WebhookTriggerEvents.BOOKING_CREATED;
    const subscriberOptions = {
      userId: organizerUser.id,
      eventTypeId,
      triggerEvent: eventTrigger,
    };

    const subscriberOptionsMeetingEnded = {
      userId: organizerUser.id,
      eventTypeId,
      triggerEvent: WebhookTriggerEvents.MEETING_ENDED,
    };

    try {
      const subscribersMeetingEnded = await getWebhooks(subscriberOptionsMeetingEnded);

      subscribersMeetingEnded.forEach((subscriber) => {
        if (rescheduleUid && originalRescheduledBooking) {
          cancelScheduledJobs(originalRescheduledBooking, undefined, true);
        }
        if (booking && booking.status === BookingStatus.ACCEPTED) {
          scheduleTrigger(booking, subscriber.subscriberUrl, subscriber);
        }
      });
    } catch (error) {
      log.error("Error while running scheduledJobs for booking", error);
      Sentry.captureException(error);
    }

    try {
      // Send Webhook call if hooked to BOOKING_CREATED & BOOKING_RESCHEDULED
      const subscribers = await getWebhooks(subscriberOptions);
      const bookingId = booking?.id;

      const eventTypeInfo: EventTypeInfo = {
        eventTitle: eventType.title,
        eventDescription: eventType.description,
        requiresConfirmation: requiresConfirmation || null,
        price: stripeAppData.price,
        currency: eventType.currency,
        length: eventType.length,
      };

      const promises = subscribers.map((sub) =>
        sendPayload(sub.secret, eventTrigger, new Date().toISOString(), sub, {
          ...evt,
          ...eventTypeInfo,
          bookingId,
          rescheduleUid,
          rescheduleStartTime: originalRescheduledBooking?.startTime
            ? dayjs(originalRescheduledBooking?.startTime).utc().format()
            : undefined,
          rescheduleEndTime: originalRescheduledBooking?.endTime
            ? dayjs(originalRescheduledBooking?.endTime).utc().format()
            : undefined,
          metadata: { ...metadata, ...reqBody.metadata },
          eventTypeId,
          status: "ACCEPTED",
          smsReminderNumber: booking?.smsReminderNumber || undefined,
        }).catch((e) => {
          console.error(`Error executing webhook for event: ${eventTrigger}, URL: ${sub.subscriberUrl}`, e);
          Sentry.captureException(e);
        })
      );
      await Promise.all(promises);
    } catch (error) {
      log.error("Error while sending webhook", error);
      Sentry.captureException(error);
    }
  }

  // Avoid passing referencesToCreate with id unique constrain values
  // refresh hashed link if used
  const urlSeed = `${organizerUser.username}:${dayjs(reqBody.start).utc().format()}`;
  const hashedUid = translator.fromUUID(uuidv5(urlSeed, uuidv5.URL));

  try {
    if (hasHashedBookingLink) {
      await prisma.hashedLink.update({
        where: {
          link: reqBody.hashedLink as string,
        },
        data: {
          link: hashedUid,
        },
      });
    }
  } catch (error) {
    log.error("Error while updating hashed link", error);
    Sentry.captureException(error);
  }

  if (!booking) throw new HttpError({ statusCode: 400, message: "Booking failed" });

  try {
    await prisma.booking.update({
      where: {
        uid: booking.uid,
      },
      data: {
        metadata: { ...(typeof booking.metadata === "object" && booking.metadata), ...metadata },
        references: {
          createMany: {
            data: referencesToCreate,
          },
        },
      },
    });
  } catch (error) {
    log.error("Error while creating booking references", error);
    Sentry.captureException(error);
  }

  try {
    await scheduleWorkflowReminders(
      eventType.workflows,
      reqBody.smsReminderNumber as string | null,
      { ...evt, ...{ metadata } },
      evt.requiresConfirmation || false,
      rescheduleUid ? true : false,
      true
    );
  } catch (error) {
    log.error("Error while scheduling workflow reminders", error);
    Sentry.captureException(error);
  }

  // booking successful
  req.statusCode = 201;
  return booking;
}

export default handler;

function handleCustomInputs(
  eventTypeCustomInputs: EventTypeCustomInput[],
  reqCustomInputs: {
    value: string | boolean;
    label: string;
  }[]
) {
  eventTypeCustomInputs.forEach((etcInput) => {
    if (etcInput.required) {
      const input = reqCustomInputs.find((i) => i.label === etcInput.label);
      if (etcInput.type === "BOOL") {
        z.literal(true, {
          errorMap: () => ({ message: `Missing ${etcInput.type} customInput: '${etcInput.label}'` }),
        }).parse(input?.value);
      } else if (etcInput.type === "PHONE") {
        z.string({
          errorMap: () => ({
            message: `Missing ${etcInput.type} customInput: '${etcInput.label}'`,
          }),
        })
          .refine((val) => isValidPhoneNumber(val), {
            message: "Phone number is invalid",
          })
          .parse(input?.value);
      } else {
        // type: NUMBER are also passed as string
        z.string({
          errorMap: () => ({ message: `Missing ${etcInput.type} customInput: '${etcInput.label}'` }),
        })
          .min(1)
          .parse(input?.value);
      }
    }
  });
}
