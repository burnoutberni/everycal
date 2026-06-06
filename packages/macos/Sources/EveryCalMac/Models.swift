import Foundation
import SwiftUI

enum CalendarViewMode: String, CaseIterable, Identifiable {
    case month = "Month"
    case week = "Week"
    case day = "Day"
    case agenda = "Agenda"
    case inbox = "Inbox"

    var id: String { rawValue }
}

enum EventVisibility: String, CaseIterable, Codable, Identifiable {
    case `public`
    case unlisted
    case followersOnly = "followers_only"
    case `private`

    var id: String { rawValue }

    var label: String {
        switch self {
        case .public: "Public"
        case .unlisted: "Unlisted"
        case .followersOnly: "Followers"
        case .private: "Private"
        }
    }
}

enum RSVPStatus: String, Codable, CaseIterable, Identifiable {
    case going
    case maybe

    var id: String { rawValue }
    var label: String { self == .going ? "Going" : "Maybe" }
}

struct EveryCalUser: Codable, Identifiable, Equatable {
    let id: String
    let username: String
    let displayName: String?
    let email: String?
    let timezone: String?
    let avatarUrl: String?

    var bestName: String { displayName?.isEmpty == false ? displayName! : username }
}

struct AuthResponse: Codable {
    let user: EveryCalUser
    let expiresAt: String
}

struct EventsResponse: Codable {
    let events: [EveryCalEvent]
    let nextCursor: String?
}

struct LocationPayload: Codable, Equatable {
    var name: String
    var address: String?
    var latitude: Double?
    var longitude: Double?
    var url: String?
}

struct EventImagePayload: Codable, Equatable {
    var url: String
    var mediaType: String?
    var alt: String?
}

struct EveryCalEvent: Codable, Identifiable, Equatable {
    var id: String
    var slug: String?
    var title: String
    var description: String?
    var startDate: String
    var endDate: String?
    var startAtUtc: String?
    var endAtUtc: String?
    var eventTimezone: String?
    var allDay: Bool
    var location: LocationPayload?
    var image: EventImagePayload?
    var url: String?
    var tags: [String]
    var visibility: String
    var canceled: Bool?
    var rsvpStatus: RSVPStatus?
    var createdAt: String
    var updatedAt: String

    var safeVisibility: EventVisibility {
        EventVisibility(rawValue: visibility) ?? .private
    }

    var startInstant: Date {
        Date.parseEveryCalISO(startAtUtc ?? startDate) ?? .now
    }

    var endInstant: Date? {
        guard let endAtUtc = endAtUtc ?? endDate else { return nil }
        return Date.parseEveryCalISO(endAtUtc)
    }

    var displayDateInterval: DateInterval {
        DateInterval(start: startInstant, end: endInstant ?? startInstant.addingTimeInterval(3600))
    }

    var tagLine: String {
        tags.isEmpty ? "No tags" : tags.map { "#\($0)" }.joined(separator: " ")
    }
}

struct EventDraft: Identifiable, Equatable {
    var id: String?
    var title: String = ""
    var notes: String = ""
    var start: Date = .now
    var end: Date = Calendar.current.date(byAdding: .hour, value: 1, to: .now) ?? .now
    var isAllDay: Bool = false
    var timezone: String = TimeZone.current.identifier
    var locationName: String = ""
    var locationAddress: String = ""
    var url: String = ""
    var tags: String = ""
    var visibility: EventVisibility = .private

    var isNew: Bool { id == nil }

    init() {}

    init(event: EveryCalEvent) {
        id = event.id
        title = event.title
        notes = event.description ?? ""
        start = event.startInstant
        end = event.endInstant ?? event.startInstant.addingTimeInterval(3600)
        isAllDay = event.allDay
        timezone = event.eventTimezone ?? TimeZone.current.identifier
        locationName = event.location?.name ?? ""
        locationAddress = event.location?.address ?? ""
        url = event.url ?? ""
        tags = event.tags.joined(separator: ", ")
        visibility = event.safeVisibility
    }

    func inputPayload() -> EventInputPayload {
        let trimmedTags = tags
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let location = locationName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? nil
            : LocationPayload(
                name: locationName,
                address: locationAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : locationAddress,
                latitude: nil,
                longitude: nil,
                url: nil
            )
        return EventInputPayload(
            title: title,
            description: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes,
            startDate: isAllDay ? DateFormatter.everycalDate.string(from: start) : DateFormatter.everycalDateTime.string(from: start),
            endDate: isAllDay ? DateFormatter.everycalDate.string(from: end) : DateFormatter.everycalDateTime.string(from: end),
            eventTimezone: timezone,
            allDay: isAllDay,
            location: location,
            url: url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : url,
            tags: trimmedTags,
            visibility: visibility.rawValue
        )
    }
}

struct EventInputPayload: Codable, Equatable {
    let title: String
    let description: String?
    let startDate: String
    let endDate: String?
    let eventTimezone: String
    let allDay: Bool
    let location: LocationPayload?
    let url: String?
    let tags: [String]
    let visibility: String
}

struct PendingChange: Identifiable, Equatable {
    enum Operation: String {
        case create
        case update
        case delete
    }

    let id = UUID()
    var operation: Operation
    var title: String
    var createdAt: Date = .now
    var retryCount: Int = 0
}

extension ISO8601DateFormatter {
    static let everycal: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let everycalWithoutFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

extension Date {
    static func parseEveryCalISO(_ value: String) -> Date? {
        ISO8601DateFormatter.everycal.date(from: value)
            ?? ISO8601DateFormatter.everycalWithoutFractions.date(from: value)
            ?? DateFormatter.everycalDateTime.date(from: value)
            ?? DateFormatter.everycalDate.date(from: value)
    }
}

extension DateFormatter {
    static let everycalDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static let everycalDateTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter
    }()

    static let dayHeader: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .full
        formatter.timeStyle = .none
        return formatter
    }()

    static let monthHeader: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "LLLL yyyy"
        return formatter
    }()

    static let eventTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()
}
