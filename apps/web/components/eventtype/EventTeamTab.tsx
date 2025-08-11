import { SchedulingType } from "@prisma/client/";
import { EventTypeSetupProps, FormValues } from "pages/event-types/[type]";
import { useMemo } from "react";
import { Controller, useFormContext } from "react-hook-form";

import CheckedTeamSelect from "@calcom/features/eventtypes/components/CheckedTeamSelect";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Label, Select } from "@calcom/ui";

interface IMemberToValue {
  id: number | null;
  name: string | null;
  username: string | null;
  email: string;
}

const mapUserToValue = ({ id, name, username, email }: IMemberToValue) => ({
  value: `${id || ""}`,
  label: `${name || ""}`,
  avatar: `${WEBAPP_URL}/${username}/avatar.png`,
  email,
});

export const EventTeamTab = ({
  eventType,
  team,
  teamMembers,
}: Pick<EventTypeSetupProps, "eventType" | "teamMembers" | "team">) => {
  const formMethods = useFormContext<FormValues>();
  const { t } = useLocale();

  const schedulingTypeOptions: {
    value: SchedulingType;
    label: string;
    // description: string;
  }[] = [
    {
      value: SchedulingType.COLLECTIVE,
      label: t("collective"),
      // description: t("collective_description"),
    },
    {
      value: SchedulingType.ROUND_ROBIN,
      label: t("round_robin"),
      // description: t("round_robin_description"),
    },
  ];

  const teamMembersToValues = useMemo(() => {
    return teamMembers.map(mapUserToValue);
  }, [teamMembers]);
  return <div>{team && <div className="space-y-3">What are you looking for?</div>}</div>;
};
