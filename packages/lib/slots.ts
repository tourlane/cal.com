import dayjs, { Dayjs } from "@calcom/dayjs";
import { WorkingHours, TimeRange as DateOverride } from "@calcom/types/schedule";

import { getWorkingHours } from "./availability";

export type GetSlots = {
  inviteeDate: Dayjs;
  frequency: number;
  workingHours: WorkingHours[];
  minimumBookingNotice: number;
  eventLength: number;
};

export type GetSlotsCompact = {
  slotDay: Dayjs;
  shiftStart: Dayjs;
  shiftEnd: Dayjs;
  days: number[];
  minStartTime: Dayjs;
  eventLength: number;
  busyTimes: { start: Dayjs; end: Dayjs }[];
};

// slots in minute format, e.g. startTime: 60, endTime: 90 would be 01:00 - 01:30.
export type TimeFrame = { startTime: number; endTime: number };

const minimumOfOne = (input: number) => (input < 1 ? 1 : input);

/**
 * TODO: What does this function do?
 * Why is it needed?
 */
const splitAvailableTime = (
  startTimeMinutes: number,
  endTimeMinutes: number,
  frequency: number,
  eventLength: number
): TimeFrame[] => {
  let initialTime = startTimeMinutes;
  const finalizationTime = endTimeMinutes;
  const result = [] as TimeFrame[];

  // Ensure that both the frequency and event length are at least 1 minute, if they
  // would be zero, we would have an infinite loop in this while!
  const frequencyMinimumOne = minimumOfOne(frequency);
  const eventLengthMinimumOne = minimumOfOne(eventLength);

  while (initialTime < finalizationTime) {
    const periodTime = initialTime + frequencyMinimumOne;
    const slotEndTime = initialTime + eventLengthMinimumOne;
    /*
    check if the slot end time surpasses availability end time of the user
    1 minute is added to round up the hour mark so that end of the slot is considered in the check instead of x9
    eg: if finalization time is 11:59, slotEndTime is 12:00, we ideally want the slot to be available
    */
    if (slotEndTime <= finalizationTime + 1) result.push({ startTime: initialTime, endTime: periodTime });
    // Ensure that both the frequency and event length are at least 1 minute, if they
    // would be zero, we would have an infinite loop in this while!
    initialTime += frequencyMinimumOne;
  }
  return result;
};

function buildSlots({
  startOfInviteeDay,
  computedLocalAvailability,
  frequency,
  eventLength,
  startDate,
}: {
  computedLocalAvailability: TimeFrame[];
  startOfInviteeDay: Dayjs;
  startDate: Dayjs;
  frequency: number;
  eventLength: number;
}) {
  const slots: Dayjs[] = [];
  const slotsInMinutes: TimeFrame[] = splitAvailableTime(
    computedLocalAvailability[0].startTime,
    computedLocalAvailability[0].endTime,
    frequency,
    eventLength
  );

  slotsInMinutes.forEach((item) => {
    const slot = startOfInviteeDay.add(item.startTime, "minute");
    // Validating slot its not on the past
    if (!slot.isBefore(startDate)) {
      slots.push(slot);
    }
  });

  return slots;
}

// Returns true if slot1 overlaps with slot2.
// Equality of startTime 1 and endTime 2 or endTime 1 and startTime 2 is NOT considered an overlap.
export function slotsOverlap(
  slot1: { startTime: Dayjs; endTime: Dayjs },
  slot2: { startTime: Dayjs; endTime: Dayjs }
) {
  return slot1.startTime.isBefore(slot2.endTime) && slot1.endTime.isAfter(slot2.startTime);
}

/**
 * This function returns the slots available for a given day.
 * `getSlots` does not take busy times into account. This is why
 * the slots that are not available must be filtered out afterwards.
 * `getSlotsCompact` takes busy times into account and returns the
 * slots as compact as possible, trying to avoid gaps between slots
 * in the calendar. For example, if the user is busy from 9:00 to
 * 09:50 and the event length is 30 minutes, the next slot will be
 * at 09:50 instead of 10:00. The 10 minutes are not lost.
 *
 * Note that the current implementation of `getSlotsCompact` only really
 * makes sense for events with a single host. We assume that `busyTimes`
 * only contains busy times for a single host.
 **/
export const getTimeSlotsCompact = ({
  // Day for which slots are being generated
  slotDay,
  // Start of the shift on that day
  shiftStart,
  // End of the shift on that day
  shiftEnd,
  // Array of integers. Days of the week that the shift is active: 0 = Sunday, 1 = Monday, etc.
  days,
  // Minimum start time of a slot (at least 2 hours from now for example)
  minStartTime,
  // Length of the event in minutes
  eventLength,
  // Array of busy times ({ startTime, endTime }) for the day
  busyTimes,
}: GetSlotsCompact): Dayjs[] => {
  if (slotDay.isBefore(minStartTime, "day")) {
    return [];
  }

  if (!days.includes(slotDay.day())) {
    return [];
  }

  const ret = [] as Dayjs[];
  let slotStartTime = shiftStart;
  let slotEndTime = slotStartTime.add(eventLength, "minute");

  while (slotEndTime.isSameOrBefore(shiftEnd)) {
    if (slotStartTime.isSameOrAfter(minStartTime)) {
      const busyTimeBlockingThisSlot = busyTimes.find((busyTime) => {
        return slotsOverlap(
          { startTime: slotStartTime, endTime: slotEndTime },
          { startTime: busyTime.start, endTime: busyTime.end }
        );
      });
      if (busyTimeBlockingThisSlot) {
        // This slot is busy, skip it.
        // Set the next startTime to the end of this busy slot.
        // The next slot will begin right after it.
        slotStartTime = busyTimeBlockingThisSlot.end;
        slotEndTime = slotStartTime.add(eventLength, "minute");
        continue;
      } else {
        ret.push(slotStartTime);
      }
    }
    slotStartTime = slotEndTime;
    slotEndTime = slotStartTime.add(eventLength, "minute");
  }
  return ret;
};

const getSlots = ({ inviteeDate, frequency, minimumBookingNotice, workingHours, eventLength }: GetSlots) => {
  const startDate = dayjs().add(minimumBookingNotice, "minute");
  const startOfInviteeDay = inviteeDate.startOf("day");
  const computedLocalAvailability: TimeFrame[] = workingHours.map((workingHour) => {
    return {
      startTime: workingHour.startTime,
      endTime: workingHour.endTime,
    };
  });

  console.log("computedLocalAvailability", computedLocalAvailability);
  console.log("workingHours", workingHours);

  return buildSlots({ computedLocalAvailability, startOfInviteeDay, startDate, frequency, eventLength });
};

export default getSlots;
