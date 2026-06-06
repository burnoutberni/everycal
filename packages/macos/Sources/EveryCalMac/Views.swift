import SwiftUI

struct RootCalendarView: View {
    @EnvironmentObject private var store: EveryCalStore
    @State private var showingSignIn = false

    var body: some View {
        NavigationSplitView {
            CalendarSidebar(showingSignIn: $showingSignIn)
        } detail: {
            ZStack {
                LinearGradient(colors: [.indigo.opacity(0.20), .purple.opacity(0.08), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .ignoresSafeArea()
                VStack(spacing: 0) {
                    CalendarToolbar()
                    Divider().opacity(0.5)
                    CalendarContent()
                }
                .background(.regularMaterial)
            }
        }
        .sheet(isPresented: $showingSignIn) { SignInView() }
        .sheet(item: $store.editingDraft) { draft in EventEditorView(draft: draft) }
        .sheet(isPresented: $store.showingNewEvent) { EventEditorView(draft: EventDraft()) }
        .task { await store.bootstrap() }
        .toolbar {
            ToolbarItemGroup {
                Button { store.showingNewEvent = true } label: { Label("New Event", systemImage: "plus") }
                    .keyboardShortcut("n", modifiers: [.command])
                Button { Task { await store.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .keyboardShortcut("r", modifiers: [.command])
            }
        }
    }
}

struct CalendarSidebar: View {
    @EnvironmentObject private var store: EveryCalStore
    @Binding var showingSignIn: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16).fill(.linearGradient(colors: [.pink, .purple, .blue], startPoint: .topLeading, endPoint: .bottomTrailing))
                    Image(systemName: "calendar.badge.clock").font(.title2.bold()).foregroundStyle(.white)
                }
                .frame(width: 48, height: 48)
                VStack(alignment: .leading) {
                    Text("EveryCal").font(.title2.bold())
                    Text(store.user?.bestName ?? "Native macOS")
                        .foregroundStyle(.secondary)
                }
            }

            DatePicker("Jump", selection: $store.selectedDate, displayedComponents: [.date])
                .datePickerStyle(.graphical)
                .onChange(of: store.selectedDate) { _, _ in Task { await store.refresh() } }

            Picker("View", selection: $store.mode) {
                ForEach(CalendarViewMode.allCases) { mode in Text(mode.rawValue).tag(mode) }
            }
            .pickerStyle(.segmented)
            .onChange(of: store.mode) { _, _ in Task { await store.refresh() } }

            VStack(alignment: .leading, spacing: 8) {
                Label("Calendars", systemImage: "rectangle.stack.badge.person.crop")
                    .font(.headline)
                SidebarPill(title: "My calendar", count: store.events.count, color: .blue, selected: store.selectedTag == nil) {
                    store.selectedTag = nil
                }
                ForEach(store.tags, id: \.self) { tag in
                    SidebarPill(title: "#\(tag)", count: store.events.filter { $0.tags.contains(tag) }.count, color: .purple, selected: store.selectedTag == tag) {
                        store.selectedTag = tag
                    }
                }
            }

            SyncCenter()
            Spacer()
            if store.signedIn {
                Button("Sign Out") { Task { await store.signOut() } }
                    .buttonStyle(.borderless)
            } else {
                Button("Connect EveryCal Account") { showingSignIn = true }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(minWidth: 280)
    }
}

struct SidebarPill: View {
    let title: String
    let count: Int
    let color: Color
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Circle().fill(color).frame(width: 9, height: 9)
                Text(title).lineLimit(1)
                Spacer()
                Text("\(count)").foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(selected ? color.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

struct CalendarToolbar: View {
    @EnvironmentObject private var store: EveryCalStore

    var body: some View {
        HStack(spacing: 14) {
            Button { Task { await store.moveSelection(by: .month, value: -1) } } label: { Image(systemName: "chevron.left") }
            Button("Today") { Task { await store.jumpToToday() } }
            Button { Task { await store.moveSelection(by: .month, value: 1) } } label: { Image(systemName: "chevron.right") }
            Text(DateFormatter.monthHeader.string(from: store.selectedDate))
                .font(.largeTitle.bold())
                .contentTransition(.numericText())
            Spacer()
            TextField("Search events, places, notes", text: $store.searchText)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)
                .onSubmit { Task { await store.refresh() } }
            if store.isLoading { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }
}

struct CalendarContent: View {
    @EnvironmentObject private var store: EveryCalStore

    var body: some View {
        Group {
            switch store.mode {
            case .month: MonthView()
            case .week: WeekView()
            case .day: DayView(date: store.selectedDate)
            case .agenda: AgendaView()
            case .inbox: InboxView()
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let error = store.lastError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .padding(10)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 12)
            }
        }
    }
}

struct MonthView: View {
    @EnvironmentObject private var store: EveryCalStore
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 7)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(Calendar.current.shortWeekdaySymbols, id: \.self) { day in
                Text(day).font(.caption.bold()).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            }
            ForEach(CalendarMath.monthGrid(containing: store.selectedDate)) { day in
                DayCard(day: day, events: CalendarMath.events(store.filteredEvents, on: day.date))
                    .opacity(day.isInDisplayedMonth ? 1 : 0.45)
                    .onTapGesture { store.selectedDate = day.date; store.mode = .day }
            }
        }
        .padding(24)
    }
}

struct DayCard: View {
    @EnvironmentObject private var store: EveryCalStore
    let day: CalendarDay
    let events: [EveryCalEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(Calendar.current.component(.day, from: day.date))")
                    .font(.headline)
                    .foregroundStyle(day.isToday ? .white : .primary)
                    .padding(6)
                    .background(day.isToday ? Color.accentColor : Color.clear, in: Circle())
                Spacer()
            }
            ForEach(events.prefix(4)) { event in EventChip(event: event) }
            if events.count > 4 { Text("+\(events.count - 4) more").font(.caption).foregroundStyle(.secondary) }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(minHeight: 118, maxHeight: .infinity, alignment: .topLeading)
        .background(.background.opacity(0.72), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.18)))
    }
}

struct EventChip: View {
    @EnvironmentObject private var store: EveryCalStore
    let event: EveryCalEvent

    var body: some View {
        Button { store.editingDraft = EventDraft(event: event) } label: {
            HStack(spacing: 6) {
                Circle().fill(event.safeVisibility == .private ? .orange : .blue).frame(width: 6, height: 6)
                Text(event.allDay ? "All day" : DateFormatter.eventTime.string(from: event.startInstant))
                    .foregroundStyle(.secondary)
                Text(event.title).fontWeight(.medium).lineLimit(1)
            }
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct WeekView: View {
    @EnvironmentObject private var store: EveryCalStore

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(CalendarMath.week(containing: store.selectedDate), id: \.self) { day in
                DayColumn(day: day, events: CalendarMath.events(store.filteredEvents, on: day))
            }
        }
        .padding(24)
    }
}

struct DayColumn: View {
    let day: Date
    let events: [EveryCalEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(DateFormatter.dayHeader.string(from: day)).font(.headline).lineLimit(2)
            ForEach(events) { EventRow(event: $0) }
            Spacer()
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.background.opacity(0.72), in: RoundedRectangle(cornerRadius: 20))
    }
}

struct DayView: View {
    @EnvironmentObject private var store: EveryCalStore
    let date: Date

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(DateFormatter.dayHeader.string(from: date)).font(.title.bold())
                ForEach(CalendarMath.events(store.filteredEvents, on: date)) { EventRow(event: $0) }
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct AgendaView: View {
    @EnvironmentObject private var store: EveryCalStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(store.filteredEvents) { EventRow(event: $0) }
            }
            .padding(28)
        }
    }
}

struct InboxView: View {
    @EnvironmentObject private var store: EveryCalStore

    var body: some View {
        VStack(spacing: 16) {
            Text("Invitations & pending sync")
                .font(.title.bold())
            ForEach(store.filteredEvents.filter { $0.rsvpStatus == nil }) { event in EventRow(event: event, showRSVP: true) }
            ForEach(store.pendingChanges) { change in
                Label("\(change.operation.rawValue.capitalized): \(change.title)", systemImage: "icloud.and.arrow.up")
                    .padding()
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EventRow: View {
    @EnvironmentObject private var store: EveryCalStore
    let event: EveryCalEvent
    var showRSVP = false

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            RoundedRectangle(cornerRadius: 8)
                .fill(.linearGradient(colors: [.blue, .purple], startPoint: .top, endPoint: .bottom))
                .frame(width: 6)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(event.title).font(.headline)
                    if event.canceled == true { Text("Canceled").font(.caption.bold()).foregroundStyle(.red) }
                    Spacer()
                    Text(event.safeVisibility.label).font(.caption).foregroundStyle(.secondary)
                }
                Text(event.allDay ? "All day" : "\(DateFormatter.eventTime.string(from: event.startInstant)) – \(DateFormatter.eventTime.string(from: event.endInstant ?? event.startInstant))")
                    .foregroundStyle(.secondary)
                if let location = event.location?.name { Label(location, systemImage: "mappin.and.ellipse").foregroundStyle(.secondary) }
                if !event.tagLine.isEmpty { Text(event.tagLine).font(.caption).foregroundStyle(.secondary) }
                if showRSVP {
                    HStack {
                        Button("Going") { Task { await store.setRSVP(.going, for: event) } }
                        Button("Maybe") { Task { await store.setRSVP(.maybe, for: event) } }
                    }
                }
            }
            Menu {
                Button("Edit") { store.editingDraft = EventDraft(event: event) }
                Button("Delete", role: .destructive) { Task { await store.delete(event) } }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        .padding(16)
        .background(.background.opacity(0.78), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(.white.opacity(0.15)))
    }
}

struct SyncCenter: View {
    @EnvironmentObject private var store: EveryCalStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Sync", systemImage: store.pendingChanges.isEmpty ? "checkmark.icloud" : "icloud.slash")
                .font(.headline)
            Text(store.syncMessage).font(.caption).foregroundStyle(.secondary)
            if !store.pendingChanges.isEmpty {
                Text("\(store.pendingChanges.count) queued changes").font(.caption.bold()).foregroundStyle(.orange)
            }
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}

struct SignInView: View {
    @EnvironmentObject private var store: EveryCalStore
    @Environment(\.dismiss) private var dismiss
    @State private var server = "https://everycal.localhost"
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connect EveryCal").font(.largeTitle.bold())
            Text("Use your EveryCal account to sync events, RSVPs, private calendars, and federation-aware visibility.")
                .foregroundStyle(.secondary)
            TextField("Server", text: $server).textFieldStyle(.roundedBorder)
            TextField("Username", text: $username).textFieldStyle(.roundedBorder)
            SecureField("Password", text: $password).textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Sign In") {
                    Task {
                        await store.signIn(server: server, username: username, password: password)
                        if store.signedIn { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(username.isEmpty || password.isEmpty || store.isLoading)
            }
        }
        .padding(28)
        .frame(width: 460)
    }
}

struct EventEditorView: View {
    @EnvironmentObject private var store: EveryCalStore
    @Environment(\.dismiss) private var dismiss
    @State var draft: EventDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(draft.isNew ? "New Event" : "Edit Event").font(.largeTitle.bold())
            TextField("Title", text: $draft.title).font(.title2).textFieldStyle(.roundedBorder)
            Toggle("All day", isOn: $draft.isAllDay)
            HStack {
                DatePicker("Starts", selection: $draft.start, displayedComponents: draft.isAllDay ? [.date] : [.date, .hourAndMinute])
                DatePicker("Ends", selection: $draft.end, displayedComponents: draft.isAllDay ? [.date] : [.date, .hourAndMinute])
            }
            TextField("Timezone", text: $draft.timezone).textFieldStyle(.roundedBorder)
            TextField("Location", text: $draft.locationName).textFieldStyle(.roundedBorder)
            TextField("Address", text: $draft.locationAddress).textFieldStyle(.roundedBorder)
            TextField("URL", text: $draft.url).textFieldStyle(.roundedBorder)
            TextField("Tags, comma separated", text: $draft.tags).textFieldStyle(.roundedBorder)
            Picker("Visibility", selection: $draft.visibility) {
                ForEach(EventVisibility.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            TextEditor(text: $draft.notes)
                .frame(minHeight: 120)
                .scrollContentBackground(.hidden)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    Task {
                        await store.saveDraft(draft)
                        dismiss()
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(28)
        .frame(width: 680)
    }
}
