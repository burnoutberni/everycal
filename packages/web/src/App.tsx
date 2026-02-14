import { Route, Switch, useLocation } from "wouter";
import { Header } from "./components/Header";
import { HomePage } from "./pages/HomePage";
import { TimelinePage } from "./pages/TimelinePage";
import { ExplorePage } from "./pages/ExplorePage";
import { EventPage } from "./pages/EventPage";
import { NewEventPage } from "./pages/NewEventPage";
import { EditEventPage } from "./pages/EditEventPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { useAuth } from "./hooks/useAuth";

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
          <Route path="/timeline" component={TimelinePage} />
          <Route path="/explore" component={ExplorePage} />
          <Route path="/events/new" component={NewEventPage} />
          <Route path="/events/:id/edit" component={EditEventPage} />
          <Route path="/events/:id" component={EventPage} />
          <Route path="/users/:username">{(params) => <ProfilePage username={params.username} />}</Route>
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
