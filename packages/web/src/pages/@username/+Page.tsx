import React from "react";
import { usePageContext } from "../../renderer/PageContext";
import { ProfilePage } from "../ProfilePage";

export default function Page() {
    const pageContext = usePageContext();
    const { username } = pageContext.routeParams;

    return <ProfilePage username={username} />;
}
