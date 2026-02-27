import { usePageContext } from "../../renderer/PageContextProvider";
import { ProfilePage } from "../ProfilePage";

export { Page };

function Page() {
  const pageContext = usePageContext();
  const username = pageContext.urlParsed?.search?.username as string;

  if (!username) {
    return <div className="empty-state mt-3"><p>Username not provided</p></div>;
  }

  return <ProfilePage username={username} initialProfile={pageContext.pageProps?.profile} initialEvents={pageContext.pageProps?.events} />;
}
