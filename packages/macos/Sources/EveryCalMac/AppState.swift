import Foundation
import SwiftUI

@MainActor
final class EveryCalStore: ObservableObject {
    @Published var user: EveryCalUser?
    @Published var events: [EveryCalEvent] = []
    @Published var selectedDate: Date = .now
    @Published var mode: CalendarViewMode = .month
    @Published var searchText: String = ""
    @Published var selectedTag: String?
    @Published var pendingChanges: [PendingChange] = []
    @Published var isLoading = false
    @Published var syncMessage = "Ready"
    @Published var lastError: String?
    @Published var editingDraft: EventDraft?
    @Published var showingNewEvent = false

    let api: EveryCalAPI

    init(api: EveryCalAPI = EveryCalAPI()) {
        self.api = api
    }

    var filteredEvents: [EveryCalEvent] {
        CalendarMath.events(events, matching: searchText, tag: selectedTag)
    }

    var tags: [String] {
        Array(Set(events.flatMap(\.tags))).sorted()
    }

    var signedIn: Bool { user != nil }

    func bootstrap() async {
        do {
            user = try await api.me()
            await refresh()
        } catch {
            syncMessage = "Sign in to sync your calendar"
        }
    }

    func signIn(server: String, username: String, password: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            try api.updateServer(server)
            let response = try await api.login(username: username, password: password)
            user = response.user
            syncMessage = "Connected as \(response.user.bestName)"
            lastError = nil
            await refresh()
        } catch {
            lastError = error.localizedDescription
            syncMessage = "Sign-in failed"
        }
    }

    func signOut() async {
        do { try await api.logout() } catch { }
        user = nil
        events = []
        syncMessage = "Signed out"
    }

    func refresh() async {
        guard signedIn else { return }
        isLoading = true
        defer { isLoading = false }
        let range = CalendarMath.visibleRange(for: selectedDate, mode: mode)
        do {
            let response = try await api.listEvents(from: range.from, to: range.to, query: searchText)
            events = response.events.sorted { $0.startInstant < $1.startInstant }
            syncMessage = "Synced \(events.count) events"
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            syncMessage = "Offline — changes will queue"
        }
    }

    func moveSelection(by component: Calendar.Component, value: Int) async {
        selectedDate = Calendar.current.date(byAdding: component, value: value, to: selectedDate) ?? selectedDate
        await refresh()
    }

    func jumpToToday() async {
        selectedDate = .now
        await refresh()
    }

    func saveDraft(_ draft: EventDraft) async {
        guard !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            lastError = "Give the event a title before saving."
            return
        }
        do {
            let payload = draft.inputPayload()
            if let id = draft.id {
                let updated = try await api.updateEvent(id: id, payload: payload)
                events.removeAll { $0.id == id }
                events.append(updated)
                syncMessage = "Updated \(updated.title)"
            } else {
                let created = try await api.createEvent(payload)
                events.append(created)
                syncMessage = "Created \(created.title)"
            }
            editingDraft = nil
            showingNewEvent = false
            events.sort { $0.startInstant < $1.startInstant }
            lastError = nil
        } catch {
            let operation: PendingChange.Operation = draft.id == nil ? .create : .update
            pendingChanges.append(PendingChange(operation: operation, title: draft.title))
            lastError = error.localizedDescription
            syncMessage = "Queued \(draft.title) for retry"
        }
    }

    func delete(_ event: EveryCalEvent) async {
        do {
            try await api.deleteEvent(id: event.id)
            events.removeAll { $0.id == event.id }
            syncMessage = "Deleted \(event.title)"
        } catch {
            pendingChanges.append(PendingChange(operation: .delete, title: event.title))
            lastError = error.localizedDescription
        }
    }

    func setRSVP(_ status: RSVPStatus?, for event: EveryCalEvent) async {
        do {
            try await api.rsvp(eventURI: event.id, status: status)
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }
}
