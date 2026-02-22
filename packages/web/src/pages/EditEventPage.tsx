import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { NewEventPage } from "./NewEventPage";
import { useAuth } from "../hooks/useAuth";

export function EditEventPage({ id, username, slug }: { id?: string; username?: string; slug?: string }) {
  const { t } = useTranslation(["createEvent", "common"]);
  const { user } = useAuth();
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) return <p className="text-muted">{t("common:loading")}</p>;
  if (!event) return <p className="error-text">{t("createEvent:eventNotFound")}</p>;
  if (user?.id !== event.accountId) return <p className="error-text">{t("createEvent:notAuthorized")}</p>;

  return <NewEventPage initialEvent={event} />;
}
