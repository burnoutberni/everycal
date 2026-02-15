import { Route, Switch } from "wouter";
import { Header } from "./components/Header";
import { HomePage } from "./pages/HomePage";
import { ExplorePage } from "./pages/ExplorePage";
import { FederationPage } from "./pages/FederationPage";
import { EventPage } from "./pages/EventPage";
import { NewEventPage } from "./pages/NewEventPage";
import { EditEventPage } from "./pages/EditEventPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { useAuth } from "./hooks/useAuth";

// Regex routes for /@username patterns (regexparam doesn't handle literal @ before :param)
const profileRegex = /^\/@(?<username>[^/]+)\/?$/;
const eventRegex = /^\/@(?<username>[^/]+)\/(?<slug>[^/]+)\/?$/;
const eventEditRegex = /^\/@(?<username>[^/]+)\/(?<slug>[^/]+)\/edit\/?$/;

export function App() {
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="empty-state mt-3">
        <p className="text-muted">Loading…</p>
      </div>
    );
  }

  return (
    <>
      <Header />
      <main className="container" style={{ paddingTop: "1.5rem", paddingBottom: "3rem" }}>
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/explore" component={ExplorePage} />
          <Route path="/federation" component={FederationPage} />
          <Route path="/events/new" component={NewEventPage} />

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
