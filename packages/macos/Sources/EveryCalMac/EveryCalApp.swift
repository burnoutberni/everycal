import SwiftUI

@main
struct EveryCalMacApp: App {
    @StateObject private var store = EveryCalStore()

    var body: some Scene {
        WindowGroup("EveryCal") {
            RootCalendarView()
                .environmentObject(store)
                .frame(minWidth: 1100, minHeight: 760)
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Event") { store.showingNewEvent = true }
                    .keyboardShortcut("n", modifiers: [.command])
                Button("Refresh Calendar") { Task { await store.refresh() } }
                    .keyboardShortcut("r", modifiers: [.command])
                Button("Today") { Task { await store.jumpToToday() } }
                    .keyboardShortcut("t", modifiers: [.command])
            }
        }

        Settings {
            SettingsView()
                .environmentObject(store)
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: EveryCalStore

    var body: some View {
        Form {
            Section("Account") {
                Text(store.user?.bestName ?? "Not signed in")
                Text(store.api.serverURL.absoluteString)
                    .foregroundStyle(.secondary)
            }
            Section("Defaults") {
                Text("Timezone: \(store.user?.timezone ?? TimeZone.current.identifier)")
                Text("New events default to private visibility until changed.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(24)
        .frame(width: 420)
    }
}
