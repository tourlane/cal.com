import { Prisma } from "@prisma/client";

export const baseEventTypeSelect = Prisma.validator<Prisma.EventTypeSelect>()({
  id: true,
  title: true,
  description: true,
  length: true,
  schedulingType: true,
  recurringEvent: true,
  slug: true,
  hidden: true,
  price: true,
  currency: true,
  requiresConfirmation: true,
});

export const minimalEventTypeSelect = Prisma.validator<Prisma.EventTypeSelect>()({
  id: true,
  title: true,
  length: true,
  slug: true,
});

export const bookEventTypeSelect = Prisma.validator<Prisma.EventTypeSelect>()({
  id: true,
  title: true,
  slug: true,
  description: true,
  length: true,
  locations: true,
  customInputs: true,
  periodType: true,
  periodDays: true,
  periodStartDate: true,
  periodEndDate: true,
  recurringEvent: true,
  requiresConfirmation: true,
  metadata: true,
  periodCountCalendarDays: true,
  price: true,
  currency: true,
  disableGuests: true,
  userId: true,
  seatsPerTimeSlot: true,
  workflows: {
    include: {
      workflow: {
        include: {
          steps: true,
        },
      },
    },
  },
  users: {
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      bio: true,
      avatar: true,
      theme: true,
    },
  },
});

export const availiblityPageEventTypeSelect = Prisma.validator<Prisma.EventTypeSelect>()({
  id: true,
  teamId: true,
  title: true,
  availability: true,
  description: true,
  length: true,
  price: true,
  currency: true,
  periodType: true,
  periodStartDate: true,
  periodEndDate: true,
  periodDays: true,
  periodCountCalendarDays: true,
  locations: true,
  schedulingType: true,
  recurringEvent: true,
  requiresConfirmation: true,
  schedule: {
    select: {
      availability: true,
      timeZone: true,
    },
  },
  hidden: true,
  userId: true,
  slug: true,
  minimumBookingNotice: true,
  beforeEventBuffer: true,
  afterEventBuffer: true,
  timeZone: true,
  metadata: true,
  slotInterval: true,
  seatsPerTimeSlot: true,
  users: {
    select: {
      id: true,
      avatar: true,
      name: true,
      username: true,
      hideBranding: true,
      timeZone: true,
    },
  },
});
