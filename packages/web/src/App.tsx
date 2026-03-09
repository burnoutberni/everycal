import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { Header } from "./components/Header";
import { HomePage } from "./pages/HomePage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { EventPage } from "./pages/EventPage";
import { NewEventPage } from "./pages/NewEventPage";
import { EditEventPage } from "./pages/EditEventPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { CalendarPage } from "./pages/CalendarPage";
import { CheckEmailPage } from "./pages/CheckEmailPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { EventResolvePage } from "./pages/EventResolvePage";
import { useAuth } from "./hooks/useAuth";

const ONBOARDING_EXEMPT = ["/onboarding", "/login", "/register", "/check-email", "/verify-email", "/forgot-password", "/reset-password"];

const atProfileRegex = /^\/@([^/]+)\/?$/;
const atEventRegex = /^\/@([^/]+)\/([^/]+)\/?$/;
const atEventEditRegex = /^\/@([^/]+)\/([^/]+)\/edit\/?$/;

function renderWithLayout(content: ReactNode) {
  return (
    <>
      <Header />
      <main className="container app-main" style={{ paddingBottom: "3rem" }}>
        {content}
      </main>
    </>
  );
}

export function App() {
  const { t } = useTranslation("common");
  const { user, authStatus } = useAuth();
  const [location] = useLocation();

  if (authStatus === "authenticated" && user && !user.notificationPrefs?.onboardingCompleted && !ONBOARDING_EXEMPT.some((p) => location.startsWith(p))) {
    return <Redirect to="/onboarding" />;
  }

  const atEventEditMatch = location.match(atEventEditRegex);
  if (atEventEditMatch) {
    return renderWithLayout(
      <EditEventPage username={decodeURIComponent(atEventEditMatch[1])} slug={decodeURIComponent(atEventEditMatch[2])} />
    );
  }

  const atEventMatch = location.match(atEventRegex);
  if (atEventMatch) {
    return renderWithLayout(
      <EventPage username={decodeURIComponent(atEventMatch[1])} slug={decodeURIComponent(atEventMatch[2])} />
    );
  }

  const atProfileMatch = location.match(atProfileRegex);
  if (atProfileMatch) {
    return renderWithLayout(
      <ProfilePage username={decodeURIComponent(atProfileMatch[1])} />
    );
  }

  return renderWithLayout(
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/calendar" component={CalendarPage} />
      <Route path="/discover" component={DiscoverPage} />
      <Route path="/r/event" component={EventResolvePage} />
      <Route path="/explore"><Redirect to="/discover" /></Route>
      <Route path="/federation"><Redirect to="/discover" /></Route>
      <Route path="/create">{() => <NewEventPage />}</Route>

      {/* Legacy routes */}
      <Route path="/events/:id/edit">{(params) => <EditEventPage id={params.id} />}</Route>
      <Route path="/events/:id">{(params) => <EventPage id={params.id} />}</Route>
      <Route path="/users/:username">{(params) => <ProfilePage username={params.username!} />}</Route>

      <Route path="/settings" component={SettingsPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/check-email" component={CheckEmailPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route path="/onboarding" component={OnboardingPage} />
      <Route>
        <div className="empty-state mt-3">
          <h2>{t("404")}</h2>
          <p className="text-muted">{t("pageNotFound")}</p>
        </div>
      </Route>
    </Switch>
  );
}
