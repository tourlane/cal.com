import { SelectedCalendar } from "@prisma/client";
import { createHash } from "crypto";
import _ from "lodash";

import { getCalendar } from "@calcom/app-store/_utils/getCalendar";
import getApps from "@calcom/app-store/utils";
import { getUid } from "@calcom/lib/CalEventParser";
import logger from "@calcom/lib/logger";
import { performance } from "@calcom/lib/server/perfObserver";
import type { CalendarEvent, EventBusyDate, NewCalendarEventType } from "@calcom/types/Calendar";
import { CredentialPayload, CredentialWithAppName } from "@calcom/types/Credential";
import type { EventResult } from "@calcom/types/EventManager";
import redis from "@calcom/web/lib/redis";

const log = logger.getChildLogger({ prefix: ["CalendarManager"] });

export const getCalendarCredentials = (credentials: Array<CredentialPayload>) => {
  const calendarCredentials = getApps(credentials)
    .filter((app) => app.type.endsWith("_calendar"))
    .flatMap((app) => {
      const credentials = app.credentials.flatMap((credential) => {
        const calendar = getCalendar(credential);
        return app.variant === "calendar" ? [{ integration: app, credential, calendar }] : [];
      });
      return credentials.length ? credentials : [];
    });

  return calendarCredentials;
};

export const getConnectedCalendars = async (
  calendarCredentials: ReturnType<typeof getCalendarCredentials>,
  selectedCalendars: { externalId: string }[]
) => {
  const connectedCalendars = await Promise.all(
    calendarCredentials.map(async (item) => {
      try {
        const { calendar, integration, credential } = item;

        // Don't leak credentials to the client
        const credentialId = credential.id;
        if (!calendar) {
          return {
            integration,
            credentialId,
          };
        }
        const cals = await calendar.listCalendars();
        const calendars = _(cals)
          .map((cal) => ({
            ...cal,
            readOnly: cal.readOnly || false,
            primary: cal.primary || null,
            isSelected: selectedCalendars.some((selected) => selected.externalId === cal.externalId),
            credentialId,
          }))
          .sortBy(["primary"])
          .value();
        const primary = calendars.find((item) => item.primary) ?? calendars.find((cal) => cal !== undefined);
        if (!primary) {
          return {
            integration,
            credentialId,
            error: {
              message: "No primary calendar found",
            },
          };
        }

        return {
          integration: cleanIntegrationKeys(integration),
          credentialId,
          primary,
          calendars,
        };
      } catch (error) {
        let errorMessage = "Could not get connected calendars";

        // Here you can expect for specific errors
        if (error instanceof Error) {
          if (error.message === "invalid_grant") {
            errorMessage = "Access token expired or revoked";
          }
        }

        return {
          integration: cleanIntegrationKeys(item.integration),
          credentialId: item.credential.id,
          error: {
            message: errorMessage,
          },
        };
      }
    })
  );

  return connectedCalendars;
};

/**
 * Important function to prevent leaking credentials to the client
 * @param appIntegration
 * @returns App
 */
const cleanIntegrationKeys = (
  appIntegration: ReturnType<typeof getCalendarCredentials>[number]["integration"] & {
    credentials?: Array<CredentialPayload>;
    credential: CredentialPayload;
  }
) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { credentials, credential, ...rest } = appIntegration;
  return rest;
};

const getCachedResults = async (
  withCredentials: CredentialPayload[],
  dateFrom: string,
  dateTo: string,
  selectedCalendars: SelectedCalendar[]
) => {
  const redisClient = await redis.getInstance();
  const calendarCredentials = withCredentials.filter((credential) => credential.type.endsWith("_calendar"));
  const calendars = calendarCredentials.map((credential) => getCalendar(credential));

  const startGetBusyCalendarTimes = performance.now();
  const results = calendars.map(async (c, i) => {
    /** Filter out nulls */
    if (!c) return [];
    /** We rely on the index so we can match credentials with calendars */
    const { id, type, appId } = calendarCredentials[i];
    /** We just pass the calendars that matched the credential type,
     * TODO: Migrate credential type or appId
     */
    const passedSelectedCalendars = selectedCalendars.filter((sc) => sc.integration === type);
    /** We extract external Ids so we don't cache too much */
    const selectedCalendarIds = passedSelectedCalendars.map((sc) => sc.externalId);
    /** We create a unique hash key based on the input data */
    const cacheKey = JSON.stringify({ id, selectedCalendarIds, dateFrom, dateTo });
    const cacheHashedKey = createHash("md5").update(cacheKey).digest("hex");
    /** Check if we already have cached data and return */
    const cachedAvailability = await redisClient.get(cacheHashedKey);

    if (cachedAvailability) {
      log.debug(`Cache HIT: Calendar Availability for key: ${cacheKey}`);
      return JSON.parse(cachedAvailability);
    }
    log.debug(`Cache MISS: Calendar Availability for key ${cacheKey}`);
    /** If we don't then we actually fetch external calendars (which can be very slow) */
    const availability = (await c.getAvailability(dateFrom, dateTo, passedSelectedCalendars)).map((a) => ({
      ...a,
      source: `${appId}`,
    }));
    /** We save the availability to a few seconds so recurrent calls are nearly instant */

    await redisClient.set(cacheHashedKey, JSON.stringify(availability), { EX: 30 });
    return availability;
  });
  const awaitedResults = await Promise.all(results);
  const endGetBusyCalendarTimes = performance.now();

  log.debug(
    `getBusyCalendarTimes took ${
      endGetBusyCalendarTimes - startGetBusyCalendarTimes
    }ms for creds ${calendarCredentials.map((cred) => cred.id)}`
  );
  return awaitedResults;
};

export const getBusyCalendarTimes = async (
  withCredentials: CredentialPayload[],
  dateFrom: string,
  dateTo: string,
  selectedCalendars: SelectedCalendar[]
) => {
  let results: EventBusyDate[][] = [];
  try {
    results = await getCachedResults(withCredentials, dateFrom, dateTo, selectedCalendars);
  } catch (error) {
    log.warn(error);
  }
  return results.reduce((acc, availability) => acc.concat(availability), []);
};

export const createEvent = async (
  credential: CredentialWithAppName,
  calEvent: CalendarEvent
): Promise<EventResult<NewCalendarEventType>> => {
  const uid: string = getUid(calEvent);
  const calendar = getCalendar(credential);
  let success = true;

  // Check if the disabledNotes flag is set to true
  if (calEvent.hideCalendarNotes) {
    calEvent.additionalNotes = "Notes have been hidden by the organiser"; // TODO: i18n this string?
  }

  // TODO: Surfice success/error messages coming from apps to improve end user visibility
  const creationResult = calendar
    ? await calendar.createEvent(calEvent).catch(async (error) => {
        success = false;
        /**
         * There is a time when selectedCalendar externalId doesn't match witch certain credential
         * so google returns 404.
         * */
        if (error?.code === 404) {
          return undefined;
        }
        log.error("createEvent failed", error, calEvent);
        // @TODO: This code will be off till we can investigate an error with it
        //https://github.com/calcom/cal.com/issues/3949
        // await sendBrokenIntegrationEmail(calEvent, "calendar");
        https: log.error("createEvent failed", error, calEvent);
        return undefined;
      })
    : undefined;

  return {
    appName: credential.appName,
    type: credential.type,
    success,
    uid,
    createdEvent: creationResult,
    originalEvent: calEvent,
  };
};

export const updateEvent = async (
  credential: CredentialWithAppName,
  calEvent: CalendarEvent,
  bookingRefUid: string | null,
  externalCalendarId: string | null
): Promise<EventResult<NewCalendarEventType>> => {
  const uid = getUid(calEvent);
  const calendar = getCalendar(credential);
  let success = false;
  if (bookingRefUid === "") {
    log.error("updateEvent failed", "bookingRefUid is empty", calEvent, credential);
  }
  const updatedResult =
    calendar && bookingRefUid
      ? await calendar
          .updateEvent(bookingRefUid, calEvent, externalCalendarId)
          .then((event) => {
            success = true;
            return event;
          })
          .catch(async (e) => {
            // @TODO: This code will be off till we can investigate an error with it
            // @see https://github.com/calcom/cal.com/issues/3949
            // await sendBrokenIntegrationEmail(calEvent, "calendar");
            log.error("updateEvent failed", e, calEvent);
            return undefined;
          })
      : undefined;

  return {
    appName: credential.appName,
    type: credential.type,
    success,
    uid,
    updatedEvent: updatedResult,
    originalEvent: calEvent,
  };
};

export const deleteEvent = (
  credential: CredentialPayload,
  uid: string,
  event: CalendarEvent
): Promise<unknown> => {
  const calendar = getCalendar(credential);
  if (calendar) {
    return calendar.deleteEvent(uid, event);
  }

  return Promise.resolve({});
};
