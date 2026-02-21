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
import { useAuth } from "./hooks/useAuth";

// Regex routes for /@username patterns (regexparam doesn't handle literal @ before :param)
const profileRegex = /^\/@(?<username>[^/]+)\/?$/;
const eventRegex = /^\/@(?<username>[^/]+)\/(?<slug>[^/]+)\/?$/;
const eventEditRegex = /^\/@(?<username>[^/]+)\/(?<slug>[^/]+)\/edit\/?$/;

const ONBOARDING_EXEMPT = ["/onboarding", "/login", "/register", "/check-email", "/verify-email", "/forgot-password", "/reset-password"];

export function App() {
  const { user, loading } = useAuth();
  const [location] = useLocation();

  if (loading) {
    return (
      <div className="empty-state mt-3">
        <p className="text-muted">Loading…</p>
      </div>
    );
  }

  if (user && !user.notificationPrefs?.onboardingCompleted && !ONBOARDING_EXEMPT.some((p) => location.startsWith(p))) {
    return <Redirect to="/onboarding" />;
  }

  return (
    <>
      <Header />
      <main className="container" style={{ paddingTop: "1.5rem", paddingBottom: "3rem" }}>
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/calendar" component={CalendarPage} />
          <Route path="/discover" component={DiscoverPage} />
          <Route path="/explore"><Redirect to="/discover" /></Route>
          <Route path="/federation"><Redirect to="/discover" /></Route>
          <Route path="/events/new">{() => <NewEventPage />}</Route>

          {/* /@username/:slug/edit — must be before /@username/:slug */}
          <Route path={eventEditRegex}>
            {(params) => <EditEventPage username={params.username!} slug={params.slug!} />}
          </Route>

          {/* /@username/:slug */}
          <Route path={eventRegex}>
            {(params) => <EventPage username={params.username!} slug={params.slug!} />}
          </Route>

          {/* /@username */}
          <Route path={profileRegex}>
            {(params) => <ProfilePage username={params.username!} />}
          </Route>

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
              <h2>404</h2>
              <p className="text-muted">Page not found.</p>
            </div>
          </Route>
        </Switch>
      </main>
    </>
  );
}
