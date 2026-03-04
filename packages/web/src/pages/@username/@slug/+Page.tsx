import { usePageContext } from "../../../renderer/PageContext";
import { EventPage } from "../../EventPage";

export default function Page() {
    const pageContext = usePageContext();
    const { username, slug } = pageContext.routeParams;

    return <EventPage username={username} slug={slug} />;
}
