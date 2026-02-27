import { usePageContext } from "../../renderer/PageContextProvider";
import { EventPage } from "../EventPage";

export default function Page() {
  const pageContext = usePageContext();
  const username = pageContext.urlParsed?.search?.username as string;
  const slug = pageContext.urlParsed?.search?.slug as string;

  if (!username || !slug) {
    return <div className="empty-state mt-3"><p>Event identifier not provided</p></div>;
  }

  return <EventPage username={username} slug={slug} initialEvent={pageContext.pageProps?.event} />;
}
