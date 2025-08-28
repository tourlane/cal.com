import { GetServerSidePropsContext } from "next";

import { ssrInit } from "@server/lib/ssr";

const EventTypesPage = () => {
  return (
    <div>
      <p>Calcom is defunct now. Goodbye!</p>
    </div>
  );
};

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const ssr = await ssrInit(context);

  return {
    props: {
      trpcState: ssr.dehydrate(),
    },
  };
};

export default EventTypesPage;
