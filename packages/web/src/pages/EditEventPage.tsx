import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { events as eventsApi, identities as identitiesApi, type CalEvent } from "../lib/api";
import { NewEventPage } from "./NewEventPage";
import { useAuth } from "../hooks/useAuth";

export function EditEventPage({ id, username, slug }: { id?: string; username?: string; slug?: string }) {
  const { t } = useTranslation(["createEvent", "common"]);
  const { user } = useAuth();
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [canEdit, setCanEdit] = useState<boolean | null>(null);

  useEffect(() => {
    setLoading(true);
    const promise =
      username && slug
        ? eventsApi.getBySlug(username, slug)
        : id
          ? eventsApi.get(id)
          : Promise.reject(new Error("No event identifier"));

    promise
      .then(setEvent)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id, username, slug]);

  useEffect(() => {
    if (!event || !user) {
      setCanEdit(null);
      return;
    }
    if (event.accountId === user.id) {
      setCanEdit(true);
      return;
    }
    identitiesApi.list()
      .then((res) => setCanEdit(res.identities.some((identity) => identity.id === event.accountId)))
      .catch(() => setCanEdit(false));
  }, [event, user]);

  if (loading) return <p className="text-muted">{t("common:loading")}</p>;
  if (!event) return <p className="error-text">{t("createEvent:eventNotFound")}</p>;
  if (!user) return <p className="error-text">{t("createEvent:notAuthorized")}</p>;
  if (canEdit === null) return <p className="text-muted">{t("common:loading")}</p>;
  if (!canEdit) return <p className="error-text">{t("createEvent:notAuthorized")}</p>;

  return <NewEventPage initialEvent={event} />;
}
